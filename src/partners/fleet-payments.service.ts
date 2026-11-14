import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FleetRegistryService } from './fleet-registry.service';
import {
  FleetPageDto,
  FleetPaymentDecisionDto,
  FleetPaymentDto,
} from './fleet-payments.dto';
const projection = `p.id,p.sequence::text,p."amountMinor"::text,p."paidOn"::text,p.reference,p."periodLabel",p.status,p."createdAt",p."decidedAt",p."decisionNote"`;
const assignmentProjection = `a.id,a.sequence::text,a.status,a.terms,a."periodicAmountMinor"::text,a."paymentPeriod",a."requestedAt",v.plate,v.brand,v.model,o."displayName" "organizationName",CASE WHEN a."acceptedAt" IS NOT NULL THEN concat_ws(' ',u."firstName",u."lastName") ELSE NULL END "driverName"`;
function page(rows: any[]) {
  const more = rows.length > 30;
  const items = rows.slice(0, 30);
  return {
    items: items.map(({ sequence, ...row }) => row),
    nextCursor: more ? items.at(-1).sequence : null,
  };
}
@Injectable()
export class FleetPaymentsService {
  constructor(
    private readonly db: DataSource,
    private readonly fleet: FleetRegistryService,
  ) {}
  private async assignment(
    m: EntityManager,
    user: string,
    id: string,
    org?: string,
  ) {
    if (org) await this.fleet.access(m, user, org);
    const [a] = await m.query(
      `SELECT a.*,v."organizationId",v.plate,v.brand,v.model,o."displayName" "organizationName"
      FROM fleet_registry_assignments a JOIN fleet_registry_vehicles v ON v.id=a."vehicleId"
      JOIN partner_organizations o ON o.id=v."organizationId"
      WHERE a.id=$1 AND ${org ? 'v."organizationId"' : 'a."driverId"'}=$2 FOR SHARE OF a`,
      [id, org ?? user],
    );
    if (!a) throw new NotFoundException('Affectation introuvable.');
    return a;
  }
  async assignments(user: string, options: FleetPageDto, org?: string) {
    return this.db.transaction(async (m) => {
      if (org) await this.fleet.access(m, user, org);
      return page(
        await m.query(
          `SELECT ${assignmentProjection} FROM fleet_registry_assignments a
        JOIN fleet_registry_vehicles v ON v.id=a."vehicleId" JOIN partner_organizations o ON o.id=v."organizationId" JOIN users u ON u.id=a."driverId"
        WHERE ${org ? 'v."organizationId"' : 'a."driverId"'}=$1 AND ($2::bigint IS NULL OR a.sequence<$2)
        ORDER BY a.sequence DESC LIMIT 31`,
          [org ?? user, options.before ?? null],
        ),
      );
    });
  }
  async history(user: string, id: string, options: FleetPageDto, org?: string) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const a = await this.assignment(m, user, id, org);
      const rows = await m.query(
        `SELECT ${projection} FROM fleet_external_payments p
        WHERE p."assignmentId"=$1 AND ($2::bigint IS NULL OR p.sequence<$2) ORDER BY p.sequence DESC LIMIT 31`,
        [id, options.before ?? null],
      );
      const [totals] = await m.query(
        `SELECT
        COALESCE(sum("amountMinor") FILTER (WHERE status='CONFIRMED'),0)::text "confirmedMinor",
        COALESCE(sum("amountMinor") FILTER (WHERE status='DECLARED'),0)::text "declaredMinor"
        FROM fleet_external_payments WHERE "assignmentId"=$1`,
        [id],
      );
      // These are records of external transfers, never wallet movements or automatic debts.
      return {
        ...page(rows),
        ...totals,
        assignment: {
          id: a.id,
          status: a.status,
          terms: a.terms,
          periodicAmountMinor: a.periodicAmountMinor,
          paymentPeriod: a.paymentPeriod,
          plate: a.plate,
          brand: a.brand,
          model: a.model,
          organizationName: a.organizationName,
        },
      };
    });
  }
  async declare(user: string, id: string, dto: FleetPaymentDto) {
    return this.db.transaction(async (m) => {
      const a = await this.assignment(m, user, id);
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `fleet-payment:${id}:${dto.mutationId}`,
      ]);
      const [prior] = await m.query(
        `SELECT ${projection} FROM fleet_external_payments p WHERE p."assignmentId"=$1 AND p."mutationId"=$2`,
        [id, dto.mutationId],
      );
      const reference = dto.reference.trim(),
        period = dto.periodLabel.trim();
      if (prior) {
        if (
          Number(prior.amountMinor) !== dto.amountMinor ||
          prior.paidOn !== dto.paidOn ||
          prior.reference !== reference ||
          prior.periodLabel !== period
        )
          throw new ConflictException(
            'Cette opération correspond à un autre versement.',
          );
        return { id: prior.id, status: prior.status };
      }
      if (
        !a.acceptedAt ||
        !['ACTIVE', 'ENDED'].includes(a.status) ||
        a.periodicAmountMinor === null
      )
        throw new ConflictException(
          'Acceptez d’abord un contrat avec montant périodique.',
        );
      if (reference.length < 3 || period.length < 3)
        throw new ConflictException(
          'Précisez la référence et la période concernée.',
        );
      const [{ future }] = await m.query(
        `SELECT $1::date > (now() AT TIME ZONE 'Africa/Kinshasa')::date AS future`,
        [dto.paidOn],
      );
      if (future)
        throw new ConflictException(
          'Déclarez uniquement un versement déjà effectué.',
        );
      const [row] = await m.query(
        `INSERT INTO fleet_external_payments("assignmentId","mutationId","amountMinor","paidOn",reference,"periodLabel")
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status`,
        [id, dto.mutationId, dto.amountMinor, dto.paidOn, reference, period],
      );
      return row;
    });
  }
  async decide(
    user: string,
    org: string,
    assignmentId: string,
    paymentId: string,
    dto: FleetPaymentDecisionDto,
  ) {
    return this.db.transaction(async (m) => {
      const a = await this.assignment(m, user, assignmentId, org);
      // Read access alone is not enough; reviewers may reconcile receipts even if the fleet is suspended.
      const [member] = await m.query(
        `SELECT role FROM partner_members WHERE "organizationId"=$1 AND "userId"=$2 AND status='ACTIVE' FOR SHARE`,
        [org, user],
      );
      if (
        !['ORG_ADMIN', 'ORG_MANAGER', 'FLEET_MANAGER'].includes(member?.role) ||
        a.driverId === user
      )
        throw new ForbiddenException(
          'Seul un responsable de la flotte autre que le conducteur peut confirmer ce versement.',
        );
      const [p] = await m.query(
        'SELECT * FROM fleet_external_payments WHERE id=$1 AND "assignmentId"=$2 FOR UPDATE',
        [paymentId, assignmentId],
      );
      if (!p) throw new NotFoundException('Versement introuvable.');
      const target = dto.confirm ? 'CONFIRMED' : 'REJECTED',
        note = dto.note?.trim() || null;
      if (!dto.confirm && (!note || note.length < 3))
        throw new ConflictException(
          'Indiquez pourquoi le versement est refusé.',
        );
      if (p.status === target && p.decisionNote === note)
        return { id: paymentId, status: target };
      if (p.status !== 'DECLARED')
        throw new ConflictException('Ce versement a déjà été examiné.');
      await m.query(
        'UPDATE fleet_external_payments SET status=$2,"decidedAt"=now(),"decidedBy"=$3,"decisionNote"=$4 WHERE id=$1',
        [paymentId, target, user, note],
      );
      return { id: paymentId, status: target };
    });
  }
}
