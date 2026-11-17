import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  FleetAssignDto,
  FleetRegisterDto,
  FleetReviewDto,
} from './fleet-registry.dto';
const managers = ['ORG_ADMIN', 'ORG_MANAGER', 'FLEET_MANAGER'];
@Injectable()
export class FleetRegistryService {
  constructor(private readonly db: DataSource) {}
  async pendingReview() {
    return {
      items: await this.db.query(
        `SELECT v.id,v.plate,v.brand,v.model,v.color,v.seats,v."createdAt",o."displayName" "organizationName" FROM fleet_registry_vehicles v JOIN partner_organizations o ON o.id=v."organizationId" WHERE v.status='SUBMITTED' ORDER BY v."createdAt",v.id LIMIT 100`,
      ),
    };
  }
  async access(m: EntityManager, user: string, org: string, write = false) {
    const [row] = await m.query(
      `SELECT m.role,o.status,o."partnerTypes" FROM partner_members m JOIN partner_organizations o ON o.id=m."organizationId" WHERE m."organizationId"=$1 AND m."userId"=$2 AND m.status='ACTIVE' FOR SHARE OF m,o`,
      [org, user],
    );
    if (
      !row ||
      !row.partnerTypes.some(
        (x: { type: string; status: string }) =>
          x.type === 'FLEET_OWNER' && x.status === 'ACTIVE',
      ) ||
      !['ACTIVE', 'SUSPENDED'].includes(row.status) ||
      ![
        'ORG_ADMIN',
        'ORG_MANAGER',
        'FLEET_MANAGER',
        'VIEWER',
        'FINANCE_VIEWER',
      ].includes(row.role) ||
      (write && (row.status !== 'ACTIVE' || !managers.includes(row.role)))
    )
      throw new ForbiddenException('Accès à cette flotte refusé.');
  }
  private async event(
    m: EntityManager,
    vehicle: string,
    actor: string,
    action: string,
  ) {
    await m.query(
      'INSERT INTO fleet_registry_events("vehicleId","actorId",action) VALUES($1,$2,$3)',
      [vehicle, actor, action],
    );
  }
  async list(user: string, org: string) {
    return this.db.transaction(async (m) => {
      await this.access(m, user, org);
      const items = await m.query(
        `SELECT v.id,v.plate,v.brand,v.model,v.color,v.seats,v.status,v."createdAt",v."verifiedAt",a.id "assignmentId",a.status "assignmentStatus",a."driverId",a.terms,CASE WHEN a.status='ACTIVE' THEN concat_ws(' ',u."firstName",u."lastName") ELSE NULL END "driverName" FROM fleet_registry_vehicles v LEFT JOIN fleet_registry_assignments a ON a."vehicleId"=v.id AND a.status IN ('PENDING','ACTIVE') LEFT JOIN users u ON u.id=a."driverId" WHERE v."organizationId"=$1 ORDER BY v."createdAt" DESC,v.id DESC LIMIT 100`,
        [org],
      );
      const [{ total }] = await m.query(
        'SELECT count(*) total FROM fleet_registry_vehicles WHERE "organizationId"=$1',
        [org],
      );
      return { items, total: Number(total), limit: 100 };
    });
  }
  async register(user: string, org: string, dto: FleetRegisterDto) {
    return this.db.transaction(async (m) => {
      await this.access(m, user, org, true);
      const plate = dto.plate.trim().toUpperCase().replace(/\s+/g, '');
      if (!plate || !dto.brand.trim() || !dto.model.trim() || !dto.color.trim())
        throw new ConflictException('Complétez les informations du véhicule.');
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `fleet-plate:${plate}`,
      ]);
      const [existing] = await m.query(
        'SELECT * FROM fleet_registry_vehicles WHERE plate=$1',
        [plate],
      );
      if (existing) {
        if (
          existing.organizationId !== org ||
          existing.brand !== dto.brand.trim() ||
          existing.model !== dto.model.trim() ||
          existing.color !== dto.color.trim() ||
          existing.seats !== dto.seats
        )
          throw new ConflictException('Ce véhicule est déjà enregistré.');
        return { id: existing.id };
      }
      const [row] = await m.query(
        `INSERT INTO fleet_registry_vehicles("organizationId",plate,brand,model,color,seats) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          org,
          plate,
          dto.brand.trim(),
          dto.model.trim(),
          dto.color.trim(),
          dto.seats,
        ],
      );
      await this.event(m, row.id, user, 'registered');
      return row;
    });
  }
  async review(user: string, id: string, dto: FleetReviewDto) {
    if (dto.verificationReference.trim().length < 3)
      throw new ConflictException('La référence du contrôle est requise.');
    return this.db.transaction(async (m) => {
      const [v] = await m.query(
        'SELECT * FROM fleet_registry_vehicles WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!v) throw new NotFoundException('Véhicule introuvable.');
      if (
        v.verifiedAt &&
        v.appVehicleId === dto.appVehicleId &&
        v.verificationReference === dto.verificationReference.trim()
      )
        return { id };
      if (v.status !== 'SUBMITTED')
        throw new ConflictException('Ce véhicule a déjà été examiné.');
      const [operational] = await m.query(
        `SELECT id FROM vehicles WHERE id=$1 AND "isActive"=true AND regexp_replace(upper("licensePlate"),'\\s','','g')=$2 FOR SHARE`,
        [dto.appVehicleId, v.plate],
      );
      if (!operational)
        throw new ConflictException(
          'Le véhicule actif dans Zwanga doit avoir la même plaque.',
        );
      await m.query(
        `UPDATE fleet_registry_vehicles SET status='AVAILABLE',"appVehicleId"=$2,"verifiedAt"=now(),"verificationReference"=$3 WHERE id=$1`,
        [id, dto.appVehicleId, dto.verificationReference.trim()],
      );
      await this.event(m, id, user, 'verified');
      return { id };
    });
  }
  async assign(user: string, org: string, id: string, dto: FleetAssignDto) {
    if (dto.terms.trim().length < 20)
      throw new ConflictException(
        'Précisez les conditions de mise à disposition.',
      );
    return this.db.transaction(async (m) => {
      await this.access(m, user, org, true);
      const [v] = await m.query(
        'SELECT * FROM fleet_registry_vehicles WHERE id=$1 AND "organizationId"=$2 FOR UPDATE',
        [id, org],
      );
      if (!v) throw new NotFoundException('Véhicule introuvable.');
      if (v.status !== 'AVAILABLE')
        throw new ConflictException(
          'Le véhicule doit être vérifié et disponible.',
        );
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `fleet-driver:${dto.driverId}`,
      ]);
      const [prior] = await m.query(
        `SELECT * FROM fleet_registry_assignments WHERE ("vehicleId"=$1 OR "driverId"=$2) AND status IN ('PENDING','ACTIVE')`,
        [id, dto.driverId],
      );
      if (prior) {
        if (
          prior.vehicleId === id &&
          prior.driverId === dto.driverId &&
          prior.terms === dto.terms.trim() &&
          Number(prior.periodicAmountMinor ?? 0) ===
            (dto.periodicAmountMinor ?? 0) &&
          prior.paymentPeriod === (dto.paymentPeriod ?? null)
        )
          return { id: prior.id };
        throw new ConflictException('Véhicule ou conducteur déjà affecté.');
      }
      await this.eligible(m, v.appVehicleId, dto.driverId);
      const [a] = await m.query(
        'INSERT INTO fleet_registry_assignments("vehicleId","driverId",terms,"periodicAmountMinor","paymentPeriod") VALUES($1,$2,$3,$4,$5) RETURNING id',
        [
          id,
          dto.driverId,
          dto.terms.trim(),
          dto.periodicAmountMinor ?? null,
          dto.paymentPeriod ?? null,
        ],
      );
      await this.event(m, id, user, 'assignment_offered');
      return a;
    });
  }
  private async eligible(m: EntityManager, vehicleId: string, driver: string) {
    // Do not transfer ownership or bypass the app's vehicle / KYC eligibility rules.
    const [row] = await m.query(
      `SELECT u.id FROM users u JOIN vehicles v ON v."ownerId"=u.id WHERE u.id=$1 AND u."isActive"=true AND u."isDriver"=true AND v.id=$2 AND v."isActive"=true FOR SHARE OF u,v`,
      [driver, vehicleId],
    );
    const [kyc] = await m.query(
      'SELECT status FROM kyc_documents WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1',
      [driver],
    );
    if (!row || kyc?.status !== 'approved')
      throw new ConflictException(
        'Le conducteur doit être vérifié et déjà autorisé à utiliser ce véhicule dans Zwanga.',
      );
  }
  async mine(user: string) {
    return {
      items: await this.db.query(
        `SELECT a.id,a.status,a.terms,a."periodicAmountMinor",a."paymentPeriod",a."requestedAt",v.plate,v.brand,v.model,o."displayName" "organizationName" FROM fleet_registry_assignments a JOIN fleet_registry_vehicles v ON v.id=a."vehicleId" JOIN partner_organizations o ON o.id=v."organizationId" WHERE a."driverId"=$1 ORDER BY a."requestedAt" DESC,a.id DESC LIMIT 100`,
        [user],
      ),
    };
  }
  async decide(
    user: string,
    id: string,
    accept: boolean,
    paymentTermsConfirmed = false,
  ) {
    return this.db.transaction(async (m) => {
      const [ref] = await m.query(
        'SELECT "vehicleId" FROM fleet_registry_assignments WHERE id=$1 AND "driverId"=$2',
        [id, user],
      );
      if (!ref) throw new NotFoundException('Affectation introuvable.');
      const [v] = await m.query(
        'SELECT * FROM fleet_registry_vehicles WHERE id=$1 FOR UPDATE',
        [ref.vehicleId],
      );
      const [a] = await m.query(
        'SELECT * FROM fleet_registry_assignments WHERE id=$1 AND "driverId"=$2 FOR UPDATE',
        [id, user],
      );
      const target = accept ? 'ACTIVE' : 'CANCELLED';
      if (a.status === target) return { id };
      if (a.status !== 'PENDING')
        throw new ConflictException('Cette affectation a changé.');
      if (accept) {
        if (a.periodicAmountMinor !== null && !paymentTermsConfirmed)
          throw new ConflictException(
            'Lisez et acceptez le montant périodique dans la dernière version de Zwanga.',
          );
        const [org] = await m.query(
          'SELECT status,"partnerTypes" FROM partner_organizations WHERE id=$1',
          [v.organizationId],
        );
        if (
          v.status !== 'AVAILABLE' ||
          org.status !== 'ACTIVE' ||
          !org.partnerTypes.some(
            (t: { type: string; status: string }) =>
              t.type === 'FLEET_OWNER' && t.status === 'ACTIVE',
          )
        )
          throw new ConflictException(
            'La flotte ou le véhicule est indisponible.',
          );
        await this.eligible(m, v.appVehicleId, user);
      }
      await m.query(
        `UPDATE fleet_registry_assignments SET status=$2,"acceptedAt"=CASE WHEN $2='ACTIVE' THEN now() ELSE NULL END,"endedAt"=CASE WHEN $2='CANCELLED' THEN now() ELSE NULL END WHERE id=$1`,
        [id, target],
      );
      await this.event(
        m,
        v.id,
        user,
        accept ? 'assignment_accepted' : 'assignment_declined',
      );
      return { id };
    });
  }
  async close(user: string, org: string, id: string) {
    return this.db.transaction(async (m) => {
      await this.access(m, user, org, true);
      const [v] = await m.query(
        'SELECT * FROM fleet_registry_vehicles WHERE id=$1 AND "organizationId"=$2 FOR UPDATE',
        [id, org],
      );
      if (!v) throw new NotFoundException('Véhicule introuvable.');
      const [a] = await m.query(
        `SELECT * FROM fleet_registry_assignments WHERE "vehicleId"=$1 AND status IN ('PENDING','ACTIVE') FOR UPDATE`,
        [id],
      );
      if (!a) return { id };
      if (
        a.status === 'ACTIVE' &&
        (
          await m.query(
            `SELECT id FROM trips WHERE "driverId"=$1 AND "vehicleId"=$2 AND status IN ('ongoing','upcoming') LIMIT 1`,
            [a.driverId, v.appVehicleId],
          )
        ).length
      )
        throw new ConflictException(
          'Terminez ou annulez les trajets prévus avec ce véhicule avant de clôturer l’affectation.',
        );
      await m.query(
        `UPDATE fleet_registry_assignments SET status=$2,"endedAt"=now() WHERE id=$1`,
        [a.id, a.status === 'PENDING' ? 'CANCELLED' : 'ENDED'],
      );
      await this.event(m, id, user, 'assignment_closed');
      return { id };
    });
  }
  async state(user: string, org: string, id: string, status: string) {
    return this.db.transaction(async (m) => {
      await this.access(m, user, org, true);
      const [v] = await m.query(
        'SELECT * FROM fleet_registry_vehicles WHERE id=$1 AND "organizationId"=$2 FOR UPDATE',
        [id, org],
      );
      if (!v) throw new NotFoundException('Véhicule introuvable.');
      if (
        v.status === 'SUBMITTED' ||
        (
          await m.query(
            `SELECT id FROM fleet_registry_assignments WHERE "vehicleId"=$1 AND status IN ('PENDING','ACTIVE')`,
            [id],
          )
        ).length
      )
        throw new ConflictException(
          'Vérifiez le véhicule et clôturez son affectation avant de changer sa disponibilité.',
        );
      await m.query(
        'UPDATE fleet_registry_vehicles SET status=$2 WHERE id=$1',
        [id, status],
      );
      await this.event(m, id, user, `vehicle_${status.toLowerCase()}`);
      return { id };
    });
  }
}
