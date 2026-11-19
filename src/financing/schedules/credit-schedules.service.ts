import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import type { CreditActor } from '../shared/credit.store';
import { ProposeCreditScheduleDto } from './credit-schedules.dto';
import { schedule } from './installment-schedule.policy';
import type { RescheduleRow } from '../shared/credit.rows';
import { minor } from '../shared/money';

@Injectable()
export class CreditSchedulesService {
  constructor(private readonly store: CreditStore) {}

  async propose(actor: CreditActor, id: string, dto: ProposeCreditScheduleDto) {
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'reschedule_propose',
      { id, ...dto },
      async (m) => {
        const c = await this.store.contract(m, id, undefined, true);
        await this.store.authorize(m, actor, ['collector', 'analyst']);
        if (
          c.status !== 'active' ||
          dto.installments > c.snapshot.policy.rules.maxInstallments ||
          actor.userId === c.driverId
        )
          throw new ConflictException('Rééchelonnement non autorisé.');
        const remaining = BigInt(c.principalMinor) - BigInt(c.paidMinor);
        schedule(remaining, dto.installments, dto.period, new Date());
        const [r] = await m.query<RescheduleRow[]>(
          `INSERT INTO pro_credit_reschedules("creditId","proposedBy","expectedRemainingMinor","expectedVersion",installments,period,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            id,
            actor.userId,
            remaining.toString(),
            c.scheduleVersion,
            dto.installments,
            dto.period,
            dto.reason,
          ],
        );
        await this.store.audit(
          m,
          actor.userId,
          'reschedule_proposed',
          { rescheduleId: r.id, ...dto },
          id,
        );
        await this.store.notify(m, c.driverId, id, `reschedule:${r.id}`);
        return r;
      },
    );
  }

  async reschedule(
    actor: CreditActor,
    id: string,
    mutationId: string,
    approve: boolean,
  ) {
    return this.store.mutation(
      actor.userId,
      mutationId,
      approve ? 'reschedule_approve' : 'reschedule_consent',
      { id },
      async (m) => {
        const [owner] = await m.query<{ driverId: string; creditId: string }[]>(
          'SELECT c."driverId",p."creditId" FROM pro_credit_reschedules p JOIN asset_credits c ON c.id=p."creditId" WHERE p.id=$1',
          [id],
        );
        if (!owner) throw new NotFoundException('Proposition introuvable.');
        if (approve) await this.store.authorize(m, actor, ['analyst']);
        else if (owner.driverId !== actor.userId)
          throw new NotFoundException('Proposition introuvable.');
        await this.store.driverLock(m, owner.driverId);
        await this.store.creditLock(m, owner.driverId);
        const c = await this.store.contract(m, owner.creditId, undefined, true);
        const [r] = await m.query<RescheduleRow[]>(
          'SELECT * FROM pro_credit_reschedules WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (
          r.approvedAt ||
          c.status !== 'active' ||
          r.expectedVersion !== c.scheduleVersion ||
          BigInt(r.expectedRemainingMinor) !==
            BigInt(c.principalMinor) - BigInt(c.paidMinor)
        )
          throw new ConflictException(
            'Le financement a changé. Une nouvelle proposition est nécessaire.',
          );
        if (!approve) {
          await m.query(
            'UPDATE pro_credit_reschedules SET "consentedAt"=COALESCE("consentedAt",now()) WHERE id=$1',
            [id],
          );
        } else {
          if (
            !r.consentedAt ||
            r.proposedBy === actor.userId ||
            actor.userId === c.driverId
          )
            throw new ConflictException(
              'Accord du conducteur et approbateur distinct requis.',
            );
          const installments = schedule(
            minor(r.expectedRemainingMinor),
            r.installments,
            r.period,
            new Date(r.createdAt),
          );
          if (new Date(installments[0].dueAt) <= new Date())
            throw new ConflictException(
              'Proposition expirée : créer un nouvel échéancier.',
            );
          if (
            !c.mandateUntil ||
            new Date(c.mandateUntil) < new Date(installments.at(-1)!.dueAt) ||
            c.mandateRevokedAt
          )
            throw new ConflictException(
              'Mandat insuffisant pour ces échéances.',
            );
          const version = c.scheduleVersion + 1;
          for (const i of installments)
            await m.query(
              'INSERT INTO pro_credit_installments("creditId",version,ordinal,"dueAt","amountMinor") VALUES($1,$2,$3,$4,$5)',
              [c.id, version, i.ordinal, i.dueAt, i.amountMinor],
            );
          await m.query(
            'UPDATE pro_credit_contracts SET "scheduleVersion"=$2,"scheduleBaselineMinor"=$3 WHERE "creditId"=$1',
            [c.id, version, c.paidMinor],
          );
          await m.query(
            'UPDATE pro_credit_reschedules SET "approvedBy"=$2,"approvedAt"=now() WHERE id=$1',
            [id, actor.userId],
          );
        }
        await this.store.audit(
          m,
          actor.userId,
          approve ? 'reschedule_approved' : 'reschedule_consented',
          { rescheduleId: id },
          c.id,
        );
        return { id, approved: approve };
      },
    );
  }
}
