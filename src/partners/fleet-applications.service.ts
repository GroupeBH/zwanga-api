import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FleetRegistryService } from './fleet-registry.service';
import {
  ApplyToFleetDto,
  FleetApplicationsQueryDto,
  FleetDirectoryDto,
  ReviewFleetApplicationDto,
} from './fleet-applications.dto';

const activeFleet = `o.status='ACTIVE' AND o."partnerTypes" @> '[{"type":"FLEET_OWNER","status":"ACTIVE"}]'::jsonb`;
const managers = ['ORG_ADMIN', 'ORG_MANAGER', 'FLEET_MANAGER'];

@Injectable()
export class FleetApplicationsService {
  constructor(
    private readonly db: DataSource,
    private readonly registry: FleetRegistryService,
  ) {}

  private async activeUser(m: EntityManager, user: string) {
    const [u] = await m.query(
      'SELECT id FROM users WHERE id=$1 AND "isActive"=true FOR SHARE',
      [user],
    );
    if (!u) throw new ForbiddenException('Votre compte doit être actif.');
  }

  private async event(
    m: EntityManager,
    id: string,
    user: string,
    action: string,
  ) {
    await m.query(
      'INSERT INTO fleet_application_events("applicationId","actorId",action) VALUES($1,$2,$3)',
      [id, user, action],
    );
  }

  async directory(user: string, dto: FleetDirectoryDto) {
    return this.db.transaction(async (m) => {
      await this.activeUser(m, user);
      // Literal search: '%' and '_' must not turn into wildcard queries.
      const search =
        '%' + (dto.search ?? '').trim().replace(/[\\%_]/g, '\\$&') + '%';
      const where = `${activeFleet} AND o."displayName" ILIKE $1`;
      const [{ total }] = await m.query(
        `SELECT count(*) total FROM partner_organizations o WHERE ${where}`,
        [search],
      );
      const items = await m.query(
        `SELECT o.id,o."displayName" FROM partner_organizations o WHERE ${where} ORDER BY o."displayName",o.id LIMIT $2 OFFSET $3`,
        [search, dto.limit, (dto.page - 1) * dto.limit],
      );
      return { items, total: Number(total), page: dto.page, limit: dto.limit };
    });
  }

  async apply(user: string, org: string, dto: ApplyToFleetDto) {
    return this.db.transaction(async (m) => {
      await this.activeUser(m, user);
      const [fleet] = await m.query(
        `SELECT o.id FROM partner_organizations o WHERE o.id=$1 AND ${activeFleet} FOR SHARE`,
        [org],
      );
      if (!fleet)
        throw new NotFoundException(
          'Cette flotte ne reçoit pas de candidatures.',
        );
      const [member] = await m.query(
        'SELECT role FROM partner_members WHERE "organizationId"=$1 AND "userId"=$2 AND status=\'ACTIVE\'',
        [org, user],
      );
      if (member && managers.includes(member.role))
        throw new ConflictException('Vous gérez déjà cette flotte.');
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `fleet-application:${org}:${user}`,
      ]);
      const [existing] = await m.query(
        `SELECT id,status FROM fleet_driver_applications WHERE "organizationId"=$1 AND "userId"=$2 AND status IN ('PENDING','ACCEPTED')`,
        [org, user],
      );
      // Retrying a submission after a network timeout must not create a second application.
      if (existing) return existing;
      const [row] = await m.query(
        `INSERT INTO fleet_driver_applications("organizationId","userId",message) VALUES($1,$2,$3) RETURNING id,status`,
        [org, user, dto.message.trim()],
      );
      await this.event(m, row.id, user, 'submitted');
      return row;
    });
  }

  private async manager(
    m: EntityManager,
    user: string,
    org: string,
    write: boolean,
  ) {
    await this.activeUser(m, user);
    await this.registry.access(m, user, org, write);
    const [member] = await m.query(
      'SELECT role FROM partner_members WHERE "organizationId"=$1 AND "userId"=$2 AND status=\'ACTIVE\'',
      [org, user],
    );
    // Candidate identity/contact details are not exposed to finance or generic viewers.
    if (!member || !managers.includes(member.role))
      throw new ForbiddenException('Accès aux candidatures refusé.');
  }

  async list(user: string, org: string | null, dto: FleetApplicationsQueryDto) {
    return this.db.transaction(async (m) => {
      if (org) await this.manager(m, user, org, false);
      else await this.activeUser(m, user);
      const where = `a.${org ? '"organizationId"' : '"userId"'}=$1 AND ($2::text IS NULL OR a.status=$2)`;
      const params = [org ?? user, dto.status ?? null];
      const [{ total }] = await m.query(
        `SELECT count(*) total FROM fleet_driver_applications a WHERE ${where}`,
        params,
      );
      const items = await m.query(
        `SELECT a.id,a."organizationId",a.message,a.status,a."decisionNote",a."createdAt",a."updatedAt",a."reviewedAt",o."displayName" "organizationName"
        ${org ? ',a."userId",u."firstName",u."lastName",u.phone,u."isDriver",u."isActive" "applicantActive"' : ''}
        FROM fleet_driver_applications a JOIN partner_organizations o ON o.id=a."organizationId"
        ${org ? 'JOIN users u ON u.id=a."userId"' : ''}
        WHERE ${where} ORDER BY a."createdAt" DESC,a.id DESC LIMIT $3 OFFSET $4`,
        [...params, dto.limit, (dto.page - 1) * dto.limit],
      );
      return { items, total: Number(total), page: dto.page, limit: dto.limit };
    });
  }

  async review(
    user: string,
    org: string,
    id: string,
    dto: ReviewFleetApplicationDto,
  ) {
    return this.db.transaction(async (m) => {
      await this.manager(m, user, org, true);
      const [application] = await m.query(
        'SELECT * FROM fleet_driver_applications WHERE id=$1 AND "organizationId"=$2 FOR UPDATE',
        [id, org],
      );
      if (!application) throw new NotFoundException('Candidature introuvable.');
      if (application.userId === user)
        throw new ForbiddenException(
          'Vous ne pouvez pas examiner votre candidature.',
        );
      if (application.status === dto.status)
        return { id, status: application.status };
      if (application.status !== 'PENDING')
        throw new ConflictException('Cette candidature a déjà été traitée.');
      if (dto.status === 'ACCEPTED')
        await this.activeUser(m, application.userId);
      await m.query(
        `UPDATE fleet_driver_applications SET status=$2,"decisionNote"=$3,"reviewedBy"=$4,"reviewedAt"=now(),"updatedAt"=now() WHERE id=$1`,
        [id, dto.status, dto.note?.trim() || null, user],
      );
      await this.event(m, id, user, dto.status.toLowerCase());
      // No driver privileges, vehicle ownership or financial contract are granted here.
      return { id, status: dto.status };
    });
  }

  async withdraw(user: string, id: string) {
    return this.db.transaction(async (m) => {
      await this.activeUser(m, user);
      const [application] = await m.query(
        'SELECT status FROM fleet_driver_applications WHERE id=$1 AND "userId"=$2 FOR UPDATE',
        [id, user],
      );
      if (!application) throw new NotFoundException('Candidature introuvable.');
      if (application.status === 'WITHDRAWN')
        return { id, status: application.status };
      if (application.status !== 'PENDING')
        throw new ConflictException(
          'Seule une candidature en attente peut être retirée.',
        );
      await m.query(
        `UPDATE fleet_driver_applications SET status='WITHDRAWN',"updatedAt"=now() WHERE id=$1`,
        [id],
      );
      await this.event(m, id, user, 'withdrawn');
      return { id, status: 'WITHDRAWN' };
    });
  }
}
