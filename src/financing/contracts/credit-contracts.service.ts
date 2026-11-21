import {
  Injectable,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { CreditCatalogService } from '../catalogue/credit-catalogue.service';
import { CreditEligibilityService } from '../eligibility/credit-eligibility.service';
import { AcceptCreditContractDto } from './credit-contracts.dto';
import { evaluatePurchase } from '../commerce/purchase-eligibility.policy';
import { assertVehicleCreditEligible } from '../../asset-credit/vehicle-credit-eligibility';
import { schedule } from '../schedules/installment-schedule.policy';
import { minor } from '../shared/money';
import type { CreditActor } from '../shared/credit.store';
import type {
  ProductRow,
  RescheduleRow,
  ContractRow,
} from '../shared/credit.rows';
import { CreditPageDto } from '../shared/credit.dto';

@Injectable()
export class CreditContractsService {
  constructor(
    private readonly store: CreditStore,
    private readonly catalog: CreditCatalogService,
    private readonly eligibility: CreditEligibilityService,
  ) {}

  async accept(driverId: string, id: string, dto: AcceptCreditContractDto) {
    return this.store.mutation(
      driverId,
      dto.mutationId,
      'accept',
      { id, ...dto },
      async (m) => {
        await this.store.driverLock(m, driverId);
        await this.store.creditLock(m, driverId);
        const c = await this.store.contract(m, id, driverId, true);
        if (
          c.status !== 'offered' ||
          dto.consent !== true ||
          dto.termsHash !== c.termsHash
        )
          throw new ConflictException('Contrat modifié ou déjà accepté.');
        const cash = c.snapshot.purchase?.mode === 'cash';
        if (c.snapshot.product.kind === 'vehicle')
          await assertVehicleCreditEligible(m, driverId);
        const evaluation = evaluatePurchase(
          await this.eligibility.facts(m, driverId),
          c.snapshot.policy.rules,
          c.principalMinor,
          c.depositMinor,
          c.snapshot.product.priceMinor,
          c.snapshot.purchase?.mode,
        );
        if (!evaluation.eligible)
          throw new ConflictException({
            code: 'PRO_INELIGIBLE',
            ...evaluation,
          });
        const until = new Date(dto.mandateUntil ?? ''),
          now = new Date();
        const last = schedule(
          minor(c.principalMinor),
          c.snapshot.installments,
          c.snapshot.period,
          now,
        ).at(-1)!;
        if (
          !cash &&
          (!Number.isFinite(until.getTime()) ||
            until < new Date(last.dueAt) ||
            until.getTime() > now.getTime() + 3660 * 86400000)
        )
          throw new BadRequestException(
            'Le mandat doit couvrir l’échéancier et rester limité dans le temps.',
          );
        await m.query(
          'UPDATE asset_credits SET status=\'accepted\',"acceptedAt"=now() WHERE id=$1',
          [id],
        );
        await m.query(
          'UPDATE pro_credit_contracts SET "mandateUntil"=$2,"consentMutationId"=$3 WHERE "creditId"=$1',
          [id, cash ? null : until, dto.mutationId],
        );
        await this.store.audit(
          m,
          driverId,
          'contract_accepted',
          {
            termsHash: c.termsHash,
            mandateUntil: dto.mandateUntil,
            mutationId: dto.mutationId,
          },
          id,
        );
        await this.store.notify(m, driverId, id, `accepted:${id}`);
        return { id, status: 'accepted' };
      },
    );
  }

  async activate(actor: CreditActor, id: string, mutationId: string) {
    return this.store.mutation(
      actor.userId,
      mutationId,
      'activate',
      { id },
      async (m) => {
        const owner = await this.store.contract(m, id);
        if (owner.driverId === actor.userId)
          throw new ConflictException('Auto-activation interdite.');
        await this.store.authorize(
          m,
          actor,
          ['analyst', 'funder'],
          owner.creditorId,
        );
        await this.store.driverLock(m, owner.driverId);
        await this.store.creditLock(m, owner.driverId);
        const c = await this.store.contract(m, id, undefined, true);
        const cash = c.snapshot.purchase?.mode === 'cash';
        if (
          c.status !== 'accepted' ||
          c.depositPaidMinor !== c.depositMinor ||
          (!cash &&
            (!c.mandateUntil ||
              c.mandateRevokedAt ||
              new Date(c.mandateUntil) <= new Date())) ||
          (cash && c.paidMinor !== c.principalMinor)
        )
          throw new ConflictException(
            'Acceptation, acompte encaissé et mandat valide requis.',
          );
        const [product] = await m.query<ProductRow[]>(
          'SELECT * FROM pro_credit_products WHERE id=$1 FOR SHARE',
          [c.productId],
        );
        await this.catalog.gate(m, product);
        if (c.snapshot.product.kind === 'vehicle')
          await assertVehicleCreditEligible(m, c.driverId);
        const facts = await this.eligibility.facts(m, c.driverId);
        if (
          !facts.activeDriver ||
          !facts.kycApproved ||
          (!cash && facts.overdue)
        )
          throw new ConflictException(
            'Éligibilité à vérifier avant activation.',
          );
        if (
          c.deliveryState !== 'delivered' &&
          !(
            c.snapshot.product.kind === 'document' &&
            c.snapshot.policy.rules.allowBeforeDelivery &&
            c.deliveryState !== 'rejected'
          )
        )
          throw new ConflictException(
            'Livraison ou exécution du document requise.',
          );
        const now = new Date(),
          installments = schedule(
            minor(c.principalMinor),
            c.snapshot.installments,
            c.snapshot.period,
            now,
          );
        if (
          !cash &&
          new Date(c.mandateUntil!) < new Date(installments.at(-1)!.dueAt)
        )
          throw new ConflictException(
            'Le mandat doit être renouvelé avant activation.',
          );
        await m.query(
          `UPDATE asset_credits SET status=CASE WHEN "paidMinor"="principalMinor" THEN 'settled' ELSE 'active' END,"activatedAt"=$2,"deliveryReference"=$3,"assetReference"=$4 WHERE id=$1`,
          [
            id,
            now,
            c.deliveryProofId ?? `contractual-advance:${id}`,
            `pro:${id}`,
          ],
        );
        for (const i of installments)
          await m.query(
            'INSERT INTO pro_credit_installments("creditId",version,ordinal,"dueAt","amountMinor") VALUES($1,1,$2,$3,$4)',
            [id, i.ordinal, i.dueAt, i.amountMinor],
          );
        const postings = [
          [
            'principal',
            'credit_receivable',
            'supplier_payable',
            minor(c.snapshot.product.priceMinor) - minor(c.depositMinor),
          ],
          [
            'fees',
            'credit_receivable',
            'financing_fees_deferred',
            minor(c.snapshot.product.feeMinor),
          ],
          [
            'deposit',
            'deposit_liability',
            'supplier_payable',
            minor(c.depositMinor),
          ],
          [
            'advance',
            'prepayment_liability',
            'credit_receivable',
            minor(c.paidMinor),
          ],
        ] as const;
        for (const [key, debit, credit, amount] of postings)
          if (amount > 0n) {
            await m.query(
              `INSERT INTO pro_credit_journals("creditId","creditorId",currency,"sourceKey","debitAccount","creditAccount","amountMinor",detail)
          VALUES($1,$2,'CDF',$3,$4,$5,$6,$7)`,
              [
                id,
                c.creditorId,
                `activation:${id}:${key}`,
                debit,
                credit,
                amount.toString(),
                JSON.stringify({
                  purpose: 'activation',
                  termsHash: c.termsHash,
                  sellerId: c.snapshot.product.sellerId,
                }),
              ],
            );
          }
        await this.store.audit(m, actor.userId, 'financing_activated', {}, id);
        await this.store.notify(m, c.driverId, id, `activated:${id}`);
        return {
          id,
          status: c.paidMinor === c.principalMinor ? 'settled' : 'active',
        };
      },
    );
  }

  async detail(actor: CreditActor, id: string, admin = false) {
    const c = await this.store.contract(
      this.store.db.manager,
      id,
      admin ? undefined : actor.userId,
    );
    if (admin)
      await this.store.authorize(
        this.store.db.manager,
        actor,
        ['manager', 'analyst', 'accountant', 'collector', 'auditor', 'funder'],
        c.creditorId,
      );
    const rows = await this.store.db.query<
      { ordinal: number; dueAt: Date; amountMinor: string }[]
    >(
      'SELECT ordinal,"dueAt","amountMinor" FROM pro_credit_installments WHERE "creditId"=$1 AND version=$2 ORDER BY ordinal',
      [id, c.scheduleVersion],
    );
    let paid = BigInt(c.paidMinor) - BigInt(c.scheduleBaselineMinor);
    const installments = rows.map((i) => {
      const amount = BigInt(i.amountMinor),
        applied = paid > 0n ? (paid < amount ? paid : amount) : 0n;
      paid -= applied;
      const remaining = amount - applied;
      return {
        ...i,
        remainingMinor: remaining.toString(),
        overdueDays:
          remaining > 0n
            ? Math.max(
                0,
                Math.floor(
                  (Date.now() - new Date(i.dueAt).getTime()) / 86400000,
                ),
              )
            : 0,
      };
    });
    const proposals = await this.store.db.query<RescheduleRow[]>(
      `SELECT id,"expectedRemainingMinor","expectedVersion",installments,period,reason,"consentedAt","approvedAt","createdAt"
      FROM pro_credit_reschedules WHERE "creditId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 20`,
      [id],
    );
    const [reductions] = await this.store.db.query<{ discountMinor: string }[]>(
      'SELECT coalesce(sum("amountMinor"),0)::text AS "discountMinor" FROM asset_credit_entries WHERE "creditId"=$1 AND kind=\'discount\'',
      [id],
    );
    return {
      id: c.id,
      status: c.status,
      label: c.label,
      currency: 'CDF',
      snapshot: c.snapshot,
      termsHash: c.termsHash,
      principalMinor: c.principalMinor,
      paidMinor: (
        BigInt(c.paidMinor) - BigInt(reductions.discountMinor)
      ).toString(),
      creditedMinor: c.paidMinor,
      discountMinor: reductions.discountMinor,
      remainingMinor: (
        BigInt(c.principalMinor) - BigInt(c.paidMinor)
      ).toString(),
      depositMinor: c.depositMinor,
      depositPaidMinor: c.depositPaidMinor,
      mandateUntil: c.mandateUntil,
      mandateRevokedAt: c.mandateRevokedAt,
      deliveryState: c.deliveryState,
      installments,
      evaluation: c.evaluation,
      scheduleReviewRequired:
        BigInt(c.paidMinor) < BigInt(c.scheduleBaselineMinor),
      rescheduleProposals: proposals.map((r) => ({
        ...r,
        schedule: schedule(
          minor(r.expectedRemainingMinor),
          r.installments,
          r.period,
          new Date(r.createdAt),
        ),
      })),
    };
  }
  async list(actor: CreditActor, page: CreditPageDto, admin = false) {
    if (admin)
      await this.store.authorize(this.store.db.manager, actor, [
        'manager',
        'analyst',
        'accountant',
        'collector',
        'auditor',
      ]);
    const rows = await this.store.db.query<ContractRow[]>(
      `SELECT c.id,c.label,c.status,c."principalMinor",c."paidMinor",p."depositMinor",p."depositPaidMinor",p."deliveryState",c."createdAt"
      FROM asset_credits c JOIN pro_credit_contracts p ON p."creditId"=c.id WHERE ($1::uuid IS NULL OR c."driverId"=$1)
      AND ($2::uuid IS NULL OR c.id>$2) ORDER BY c.id LIMIT $3`,
      [admin ? null : actor.userId, page.after ?? null, page.limit + 1],
    );
    return {
      items: rows.slice(0, page.limit),
      nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }

  async revoke(driverId: string, id: string, mutationId: string) {
    return this.store.mutation(
      driverId,
      mutationId,
      'mandate_revoke',
      { id },
      async (m) => {
        await this.store.driverLock(m, driverId);
        await this.store.creditLock(m, driverId);
        await this.store.contract(m, id, driverId, true);
        await m.query(
          'UPDATE pro_credit_contracts SET "mandateRevokedAt"=COALESCE("mandateRevokedAt",now()) WHERE "creditId"=$1',
          [id],
        );
        await this.store.audit(m, driverId, 'mandate_revoked', {}, id);
        return { id, automaticRepaymentEnabled: false };
      },
    );
  }
}
