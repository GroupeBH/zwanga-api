import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from './entities';
import { FinancialRecovery1780000083000 } from './migrations/1780000083000-FinancialRecovery';
import { ReconcileFlexPayDeposits1780000067000 } from './migrations/1780000067000-ReconcileFlexPayDeposits';
import { User } from '../users/entities/user.entity';
import { WalletService } from '../wallet/wallet.service';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../subscriptions/entities/subscription.entity';
import { DocumentFundingRequest } from '../subscriptions/entities/document-funding-request.entity';
import {
  PaymentTransaction,
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service';
import { PaymentsService } from '../payments/payments.service';
import { PaymentSettlementRegistry } from '../payments/payment-settlement.registry';
import { commitFlexPayDepositState } from '../payments/flexpay-deposit-state';
import { claimReferralPayoutPayment } from '../payments/referral-payout-claim';
import { ReferralsService } from '../referrals/referrals.service';
import {
  ReferralWithdrawal,
  ReferralWithdrawalStatus,
} from '../referrals/entities/referral-withdrawal.entity';
import { ReferralAccount } from '../referrals/entities/referral-account.entity';

// Explicit opt-in: fresh loopback PostgreSQL only; no .env or provider HTTP.
const bin = process.env.FINANCIAL_RECOVERY_TEST_POSTGRES_BIN ?? process.env.PAYOUT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'financial recovery on isolated PostgreSQL',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    const config = { get: () => undefined };
    beforeAll(async () => {
      Logger.overrideLogger(false);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query(
        'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
      );
      await db.synchronize();
      await db.query(
        'ALTER TABLE referral_withdrawals DROP COLUMN "recoveryCheckedAt"',
      );
      const runner = db.createQueryRunner();
      try {
        await runner.startTransaction();
        await new ReconcileFlexPayDeposits1780000067000().up(runner);
        await new FinancialRecovery1780000083000().up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    });
    afterAll(() => cluster.stop());
    beforeEach(async () => {
      await db.query('TRUNCATE users, payment_transactions CASCADE');
    });

    async function userFixture(balance = 1000) {
      const user = await db.getRepository(User).save({
        firstName: 'Synthetic',
        lastName: 'Finance',
        isDriver: true,
      });
      const account = await db.getRepository(WalletAccount).save({
        userId: user.id,
        type: WalletAccountType.POINTS,
        currency: 'PTS',
        balance,
        withdrawableBalance: 0,
      });
      const wallet = new WalletService(
        db.getRepository(WalletAccount),
        db.getRepository(WalletLedgerEntry),
        db.getRepository(User),
        db,
        config as any,
        {} as any,
      );
      const subscriptions = new SubscriptionsService(
        db.getRepository(Subscription),
        db.getRepository(DocumentFundingRequest),
        db.getRepository(User),
        config as any,
        { del: async () => undefined } as any,
        {
          getClientPaymentMessage: () => null,
          formatLogPayload: () => '',
        } as any,
        wallet,
        { awardSubscriptionReward: jest.fn() } as any,
      );
      // Eligibility isn't under test; debit, activation and bonus use the REAL services/DB.
      jest.spyOn(subscriptions as any, 'getDriverUser').mockResolvedValue(user);
      return { user, account, wallet, subscriptions };
    }
    const pointsPurchase = (s: SubscriptionsService, id: string) =>
      s.subscribeWithPoints(id, { plan: SubscriptionPlan.PRO });

    it('serializes simultaneous Pro purchases and retries without a second debit or bonus', async () => {
      const { user, account, subscriptions } = await userFixture();
      const purchases = await Promise.all([
        pointsPurchase(subscriptions, user.id),
        pointsPurchase(subscriptions, user.id),
      ]);
      expect(purchases[0].subscription.id).toBe(purchases[1].subscription.id);
      expect(purchases.map((p) => p.payment.status)).toEqual([
        'succeeded',
        'succeeded',
      ]);
      await pointsPurchase(subscriptions, user.id);
      expect(
        await db
          .getRepository(WalletAccount)
          .findOneByOrFail({ id: account.id }),
      ).toMatchObject({ balance: '525.00' });
      expect(await db.getRepository(Subscription).count()).toBe(1);
      expect(await db.getRepository(WalletLedgerEntry).count()).toBe(2);
    });

    it('rolls back the debit AND activation if the bonus fails, then permits a clean retry', async () => {
      const { user, account, wallet, subscriptions } = await userFixture();
      const failure = jest
        .spyOn(wallet, 'awardSubscriptionPaymentTokens')
        .mockRejectedValueOnce(new Error('synthetic bonus failure'));
      await expect(pointsPurchase(subscriptions, user.id)).rejects.toThrow(
        'synthetic bonus failure',
      );
      expect(
        await db
          .getRepository(WalletAccount)
          .findOneByOrFail({ id: account.id }),
      ).toMatchObject({ balance: '1000.00' });
      expect(await db.getRepository(WalletLedgerEntry).count()).toBe(0);
      expect(await db.getRepository(Subscription).count()).toBe(0);
      failure.mockRestore();
      await expect(
        pointsPurchase(subscriptions, user.id),
      ).resolves.toMatchObject({
        subscription: { status: SubscriptionStatus.ACTIVE },
      });
    });

    it('recovers an old pending debit at its original price without charging again', async () => {
      const { user, account, wallet, subscriptions } = await userFixture();
      const old = await db.getRepository(Subscription).save({
        userId: user.id,
        plan: SubscriptionPlan.PRO,
        status: SubscriptionStatus.PENDING,
        startDate: new Date(),
        endDate: new Date(),
        amount: 200,
        currency: 'PTS',
      });
      await wallet.payForSubscription(old, 200);
      const result = await pointsPurchase(subscriptions, user.id);
      expect(result.subscription.id).toBe(old.id);
      expect(result.payment.amount).toBe(200);
      expect(
        await db
          .getRepository(WalletAccount)
          .findOneByOrFail({ id: account.id }),
      ).toMatchObject({ balance: '825.00' });
      expect(
        await db
          .getRepository(WalletLedgerEntry)
          .countBy({ type: WalletLedgerEntryType.SUBSCRIPTION_PAYMENT }),
      ).toBe(1);
    });

    async function payment(overrides: Partial<PaymentTransaction> = {}) {
      return db.getRepository(PaymentTransaction).save({
        provider: PaymentProvider.FLEXPAY,
        method: PaymentMethod.MOBILE_MONEY,
        purpose: PaymentPurpose.GENERIC,
        status: PaymentStatus.PENDING,
        reference: randomUUID(),
        amount: 5000,
        currency: 'CDF',
        ...overrides,
      });
    }

    it('refuses a points purchase while an electronic Pro payment is in flight', async () => {
      const { user, subscriptions } = await userFixture();
      await payment({
        userId: user.id,
        purpose: PaymentPurpose.SUBSCRIPTION_PRO,
      });
      await expect(pointsPurchase(subscriptions, user.id)).rejects.toThrow(
        'déjà en cours',
      );
      expect(await db.getRepository(WalletLedgerEntry).count()).toBe(0);
    });

    it.each([
      PaymentStatus.PENDING,
      PaymentStatus.INITIATED,
      PaymentStatus.FAILED,
    ])(
      'cannot overwrite a callback success with late initiation %s',
      async (status) => {
        const p = await payment({ orderNumber: 'verified-order' });
        const paidAt = new Date();
        await db
          .getRepository(PaymentTransaction)
          .update(p.id, { status: PaymentStatus.SUCCEEDED, paidAt });
        const saved = await commitFlexPayDepositState(
          db.getRepository(PaymentTransaction),
          {
            ...p,
            status,
            paidAt: null,
            providerMessage: 'late response',
          },
          true,
        );
        expect(saved.status).toBe(PaymentStatus.SUCCEEDED);
        expect(saved.paidAt).toEqual(paidAt);
      },
    );

    it('keeps PawaPay confirmed payments queued until their domain settlement succeeds', async () => {
      const p = await payment({
        provider: PaymentProvider.PAWAPAY,
        status: PaymentStatus.SUCCEEDED,
      });
      const settlement = jest
        .fn()
        .mockRejectedValueOnce(new Error('synthetic domain failure'))
        .mockResolvedValue(undefined);
      const registry = new PaymentSettlementRegistry();
      registry.register(PaymentPurpose.GENERIC, settlement);
      const payments = new PaymentsService(
        db.getRepository(PaymentTransaction),
        config as any,
        {} as any,
        {} as any,
        registry,
      );
      const worker = new PaymentReconciliationService(db, payments);
      const due = () =>
        db.query(`UPDATE payment_settlement_jobs SET "nextAttemptAt" = now()`);
      const job = async () =>
        (
          await db.query(
            `SELECT * FROM payment_settlement_jobs WHERE "paymentId" = $1`,
            [p.id],
          )
        )[0];
      await due();
      await worker.reconcile();
      expect(await job()).toMatchObject({
        completedAt: null,
        attempts: 1,
        lastError: 'VERIFICATION_OR_SETTLEMENT_FAILED',
      });
      await due();
      await worker.reconcile();
      expect((await job()).completedAt).toBeInstanceOf(Date);
      expect(settlement).toHaveBeenCalledTimes(2);
      expect(
        await db.query('SELECT * FROM payment_reconciliation_jobs'),
      ).toHaveLength(0);
    });

    it.each([PaymentStatus.FAILED, PaymentStatus.CANCELLED])('does not reopen a %s deposit on a stale pending check', async status => {
      const p = await payment({ status });
      const result = await commitFlexPayDepositState(db.getRepository(PaymentTransaction), { ...p, status: PaymentStatus.PENDING });
      expect(result.status).toBe(status);
      const success = await commitFlexPayDepositState(db.getRepository(PaymentTransaction), { ...p, status: PaymentStatus.SUCCEEDED, paidAt: new Date() });
      expect(success.status).toBe(PaymentStatus.SUCCEEDED);
    });

    it('fences acknowledgement when a callback changes the job during settlement', async () => {
      const p = await payment({ status: PaymentStatus.SUCCEEDED });
      const reconcilePayment = jest.fn(async () => {
        await db
          .getRepository(PaymentTransaction)
          .update(p.id, { orderNumber: 'callback-order' });
        return true;
      });
      await db.query(
        `UPDATE payment_settlement_jobs SET "nextAttemptAt" = now()`,
      );
      const worker = new PaymentReconciliationService(db, {
        reconcilePayment,
      } as any);
      await worker.reconcile();
      const [job] = await db.query(
        'SELECT * FROM payment_settlement_jobs WHERE "paymentId" = $1',
        [p.id],
      );
      expect(job).toMatchObject({
        completedAt: null,
        revision: 1,
        leaseToken: null,
      });
    });

    it('allows only one concurrent worker to claim a settlement job', async () => {
      await payment({ status: PaymentStatus.SUCCEEDED });
      await db.query(
        `UPDATE payment_settlement_jobs SET "nextAttemptAt" = now()`,
      );
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reconcilePayment = jest.fn(async () => {
        entered();
        await paused;
        return true;
      });
      const first = new PaymentReconciliationService(db, {
        reconcilePayment,
      } as any).reconcile();
      await started;
      try {
        await new PaymentReconciliationService(db, {
          reconcilePayment,
        } as any).reconcile();
        expect(reconcilePayment).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await first;
      }
    });

    async function orphanFixture() {
      const { user } = await userFixture();
      await db.getRepository(ReferralAccount).save({
        userId: user.id,
        availableTokens: 0,
        reservedTokens: 1000,
        pendingTokens: 0,
        withdrawnTokens: 0,
        currency: 'PTS',
      });
      const withdrawal = await db.getRepository(ReferralWithdrawal).save({
        userId: user.id,
        tokens: 1000,
        amount: 10000,
        currency: 'CDF',
        moneyPerToken: 10,
        phone: '+243891234567',
        requestedAt: new Date(Date.now() - 3600000),
        status: ReferralWithdrawalStatus.PENDING,
      });
      const draft = db.getRepository(PaymentTransaction).create({
        userId: user.id,
        purpose: PaymentPurpose.REFERRAL_PAYOUT,
        relatedEntityType: 'referral_withdrawal',
        relatedEntityId: withdrawal.id,
        provider: PaymentProvider.FLEXPAY,
        method: PaymentMethod.MOBILE_MONEY,
        status: PaymentStatus.PENDING,
        reference: randomUUID(),
        phone: withdrawal.phone,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
      });
      const service: ReferralsService = Object.assign(
        Object.create(ReferralsService.prototype),
        {
          dataSource: db,
          withdrawalRepository: db.getRepository(ReferralWithdrawal),
          WITHDRAWAL_RELATED_ENTITY_TYPE: 'referral_withdrawal',
          configService: config,
          paymentsService: {
            reconcilePayment: async () => false,
            findTransactionById: (id: string) =>
              db.getRepository(PaymentTransaction).findOneByOrFail({ id }),
          },
        },
      );
      return { user, withdrawal, draft, service };
    }
    it('releases a never-submitted reservation exactly once and blocks a late old sender', async () => {
      const { user, withdrawal, draft, service } = await orphanFixture();
      await Promise.all([
        service.recoverUnsentWithdrawal(withdrawal.id),
        service.recoverUnsentWithdrawal(withdrawal.id),
      ]);
      expect(
        await db
          .getRepository(ReferralAccount)
          .findOneByOrFail({ userId: user.id }),
      ).toMatchObject({ availableTokens: '1000.00', reservedTokens: '0.00' });
      await expect(
        claimReferralPayoutPayment(db.getRepository(PaymentTransaction), draft),
      ).rejects.toThrow();
      // A previous deployed writer bypassing the new helper is also stopped by PostgreSQL.
      await expect(
        db.getRepository(PaymentTransaction).save(draft),
      ).rejects.toThrow('not sendable');
      expect(await db.getRepository(PaymentTransaction).count()).toBe(0);
    });
    it('does not release or duplicate a possibly submitted payout without an order number', async () => {
      const { user, withdrawal, draft, service } = await orphanFixture();
      const claims = await Promise.all([
        claimReferralPayoutPayment(db.getRepository(PaymentTransaction), draft),
        claimReferralPayoutPayment(db.getRepository(PaymentTransaction), {
          ...draft,
          reference: randomUUID(),
        }),
      ]);
      expect(claims.filter((c) => c.created)).toHaveLength(1);
      await service.recoverUnsentWithdrawal(withdrawal.id);
      expect(
        await db
          .getRepository(ReferralAccount)
          .findOneByOrFail({ userId: user.id }),
      ).toMatchObject({ availableTokens: '0.00', reservedTokens: '1000.00' });
      expect(await db.getRepository(PaymentTransaction).count()).toBe(1);
    });
    it('serializes recovery racing provider submission: released OR claimed, never both', async () => {
      const { user, withdrawal, draft, service } = await orphanFixture();
      await Promise.allSettled([
        service.recoverUnsentWithdrawal(withdrawal.id),
        claimReferralPayoutPayment(db.getRepository(PaymentTransaction), draft),
      ]);
      const account = await db
        .getRepository(ReferralAccount)
        .findOneByOrFail({ userId: user.id });
      const count = await db.getRepository(PaymentTransaction).count();
      expect(count).toBeLessThanOrEqual(1);
      expect(Number(account.availableTokens)).toBe(count ? 0 : 1000);
      expect(Number(account.reservedTokens)).toBe(count ? 1000 : 0);
    });
    it('uses the confirmed DB status, not a stale failed payout callback', async () => {
      const { user, withdrawal, draft, service } = await orphanFixture();
      const claim = await claimReferralPayoutPayment(
        db.getRepository(PaymentTransaction),
        draft,
      );
      await db
        .getRepository(PaymentTransaction)
        .update(claim.payment.id, {
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
        });
      await (service as any).applyPaymentToWithdrawal(
        { ...claim.payment, status: PaymentStatus.FAILED },
        user.id,
      );
      expect(
        await db
          .getRepository(ReferralAccount)
          .findOneByOrFail({ userId: user.id }),
      ).toMatchObject({
        availableTokens: '0.00',
        reservedTokens: '0.00',
        withdrawnTokens: '1000.00',
      });
      expect(
        await db
          .getRepository(ReferralWithdrawal)
          .findOneByOrFail({ id: withdrawal.id }),
      ).toMatchObject({ status: ReferralWithdrawalStatus.SUCCEEDED });
    });
  },
);
