import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { CreditStore } from '../shared/credit.store';
import { ContractRow } from '../shared/credit.rows';
import { CreditLedgerService } from '../ledger/credit-ledger.service';
import { earlySettlement } from './commerce.policy';
import { ChangePurchasePlanDto, EarlySettlementDto } from './commerce.dto';
import { schedule } from '../schedules/installment-schedule.policy';

@Injectable()
export class CommercePaymentsService {
  constructor(
    private readonly store: CreditStore,
    private readonly ledger: CreditLedgerService,
  ) {}
  private async rows(m: EntityManager, c: ContractRow) {
    return m.query<{ ordinal: number; dueAt: Date; amountMinor: string }[]>(
      'SELECT ordinal,"dueAt","amountMinor" FROM pro_credit_installments WHERE "creditId"=$1 AND version=$2 ORDER BY ordinal',
      [c.id, c.scheduleVersion],
    );
  }
  private async settlement(m: EntityManager, c: ContractRow, now: Date) {
    if (
      c.status !== 'active' ||
      !c.snapshot.purchase ||
      ['returned', 'rejected'].includes(c.deliveryState)
    )
      throw new ConflictException(
        'Solde anticipé indisponible pour ce contrat.',
      );
    const [previous] = await m.query(
      'SELECT id FROM asset_credit_entries WHERE "creditId"=$1 AND kind=\'discount\'',
      [c.id],
    );
    if (previous)
      throw new ConflictException('La remise anticipée a déjà été appliquée.');
    const rows = await this.rows(m, c);
    let allocated = BigInt(c.paidMinor) - BigInt(c.scheduleBaselineMinor);
    let hasOverdue = allocated < 0n;
    for (const row of rows) {
      const amount = BigInt(row.amountMinor);
      if (new Date(row.dueAt) < now && allocated < amount) hasOverdue = true;
      allocated -= amount;
    }
    const [original] = await m.query<{ last: Date }[]>(
      'SELECT max("dueAt") AS last FROM pro_credit_installments WHERE "creditId"=$1 AND version=1',
      [c.id],
    );
    if (!original?.last || !rows.length)
      throw new ConflictException('Échéancier manquant.');
    // A reschedule cannot create a new discount window beyond the initial contract.
    const finalDueAt = new Date(
      Math.min(
        new Date(original.last).getTime(),
        new Date(rows.at(-1)!.dueAt).getTime(),
      ),
    ).toISOString();
    const result = earlySettlement(
      {
        remainingMinor: (
          BigInt(c.principalMinor) - BigInt(c.paidMinor)
        ).toString(),
        period: c.snapshot.purchase.period,
        finalDueAt,
        hasOverdue,
        mode: c.snapshot.purchase.mode,
        version: c.snapshot.purchase.version,
      },
      now,
    );
    const payload = {
      id: c.id,
      version: c.scheduleVersion,
      termsHash: c.termsHash,
      ...result,
    };
    return {
      ...payload,
      quoteHash: createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    };
  }
  async quote(driverId: string, id: string) {
    const c = await this.store.contract(this.store.db.manager, id, driverId);
    return this.settlement(this.store.db.manager, c, new Date());
  }
  async settle(driverId: string, id: string, dto: EarlySettlementDto) {
    try {
      return await this.store.mutation(
        driverId,
        dto.mutationId,
        'commerce_settle',
        { id, ...dto },
        async (m) => {
          await this.store.driverLock(m, driverId);
          await m.query(
            'SELECT id FROM wallet_accounts WHERE "userId"=$1 AND type=\'points\' FOR UPDATE',
            [driverId],
          );
          await this.store.creditLock(m, driverId);
          const c = await this.store.contract(m, id, driverId, true);
          const quote = await this.settlement(m, c, new Date());
          if (quote.quoteHash !== dto.quoteHash)
            throw new ConflictException(
              'Le solde a changé. Actualisez le montant.',
            );
          const [{ id: walletEntryId }] = await m.query<{ id: string }[]>(
            'SELECT zwanga_asset_wallet_debit($1,$2,$3,$4) AS id',
            [driverId, quote.amountMinor, id, dto.mutationId],
          );
          await m.query(
            `INSERT INTO asset_credit_entries("creditId","driverId",kind,"amountMinor","sourceKey","walletEntryId")
          VALUES($1,$2,'wallet',$3,$4,$5)`,
            [
              id,
              driverId,
              quote.amountMinor,
              `wallet:${dto.mutationId}`,
              walletEntryId,
            ],
          );
          await this.ledger.journal(
            m,
            c,
            `wallet:${dto.mutationId}`,
            'wallet_clearing',
            'credit_receivable',
            BigInt(quote.amountMinor),
            {
              purpose: 'early_settlement',
              status: 'CONFIRMED',
              walletEntryId,
              mutationId: dto.mutationId,
            },
          );
          if (BigInt(quote.discountMinor) > 0n) {
            await m.query(
              `INSERT INTO asset_credit_entries("creditId","driverId",kind,"amountMinor","sourceKey")
            VALUES($1,$2,'discount',$3,$4)`,
              [id, driverId, quote.discountMinor, `discount:${dto.mutationId}`],
            );
            await this.ledger.journal(
              m,
              c,
              `discount:${dto.mutationId}`,
              'commercial_discount',
              'credit_receivable',
              BigInt(quote.discountMinor),
              {
                purpose: 'early_settlement_discount',
                status: 'CONFIRMED',
                mutationId: dto.mutationId,
              },
            );
          }
          await m.query(
            'UPDATE asset_credits SET "paidMinor"="principalMinor",status=\'settled\' WHERE id=$1',
            [id],
          );
          await this.store.audit(m, driverId, 'early_settlement', quote, id);
          await this.store.notify(
            m,
            driverId,
            id,
            `early-settlement:${dto.mutationId}`,
          );
          return {
            id,
            status: 'settled',
            paidMinor: quote.amountMinor,
            discountMinor: quote.discountMinor,
            currency: 'CDF',
          };
        },
      );
    } catch (error) {
      if (
        /ASSET_(BALANCE|STATE|OWNER|REPLAY)/.test(
          error instanceof Error ? error.message : '',
        )
      )
        throw new ConflictException(
          'Solde disponible insuffisant ou paiement déjà traité.',
        );
      throw error;
    }
  }
  private async options(m: EntityManager, c: ContractRow, now: Date) {
    if (
      c.status !== 'active' ||
      c.snapshot.purchase?.mode !== 'credit' ||
      c.mandateRevokedAt ||
      !c.mandateUntil
    )
      throw new ConflictException('Changement de formule indisponible.');
    const rows = await this.rows(m, c);
    let allocated = BigInt(c.paidMinor) - BigInt(c.scheduleBaselineMinor);
    let boundary: Date | undefined;
    for (const row of rows) {
      if (new Date(row.dueAt) > now) break;
      if (allocated < BigInt(row.amountMinor))
        throw new ConflictException(
          'Payez l’échéance en cours avant de changer de formule.',
        );
      allocated -= BigInt(row.amountMinor);
      boundary = new Date(row.dueAt);
    }
    if (!boundary)
      throw new ConflictException(
        'Vous pourrez changer de formule à la fin de la période en cours, une fois payée.',
      );
    const remaining = BigInt(c.principalMinor) - BigInt(c.paidMinor);
    const plans = c.snapshot.purchase.plans.flatMap((plan) => {
      const items = schedule(remaining, plan.count, plan.period, boundary!);
      if (
        new Date(items[0].dueAt) <= now ||
        new Date(items.at(-1)!.dueAt) > new Date(c.mandateUntil!)
      )
        return [];
      return [{ ...plan, installments: items }];
    });
    return {
      id: c.id,
      version: c.scheduleVersion,
      remainingMinor: remaining.toString(),
      plans,
    };
  }
  async plans(driverId: string, id: string) {
    return this.options(
      this.store.db.manager,
      await this.store.contract(this.store.db.manager, id, driverId),
      new Date(),
    );
  }
  async changePlan(driverId: string, id: string, dto: ChangePurchasePlanDto) {
    return this.store.mutation(
      driverId,
      dto.mutationId,
      'commerce_change_plan',
      { id, ...dto },
      async (m) => {
        await this.store.driverLock(m, driverId);
        await this.store.creditLock(m, driverId);
        const c = await this.store.contract(m, id, driverId, true);
        const options = await this.options(m, c, new Date());
        const plan = options.plans.find((p) => p.id === dto.planId);
        if (
          !plan ||
          options.version !== dto.expectedVersion ||
          options.remainingMinor !== dto.expectedRemainingMinor
        )
          throw new ConflictException(
            'Le solde ou les formules ont changé. Actualisez.',
          );
        const version = c.scheduleVersion + 1;
        for (const i of plan.installments)
          await m.query(
            'INSERT INTO pro_credit_installments("creditId",version,ordinal,"dueAt","amountMinor") VALUES($1,$2,$3,$4,$5)',
            [id, version, i.ordinal, i.dueAt, i.amountMinor],
          );
        await m.query(
          'UPDATE pro_credit_contracts SET "scheduleVersion"=$2,"scheduleBaselineMinor"=$3 WHERE "creditId"=$1',
          [id, version, c.paidMinor],
        );
        await this.store.audit(
          m,
          driverId,
          'customer_plan_changed',
          {
            previousVersion: c.scheduleVersion,
            version,
            planId: plan.id,
            remainingMinor: options.remainingMinor,
          },
          id,
        );
        await this.store.notify(m, driverId, id, `plan:${dto.mutationId}`);
        return {
          id,
          version,
          planId: plan.id,
          installments: plan.installments,
        };
      },
    );
  }
}
