import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { PayoutRetries1780000105000 } from '../database/migrations/1780000105000-PayoutRetries';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import {
  DriverPayout,
  DriverPayoutStatus,
} from '../driver-settlements/entities/driver-payout.entity';
import { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';
import { DriverSettlementsService } from '../driver-settlements/driver-settlements.service';
import { DriverPayoutRecoveryService } from '../driver-settlements/driver-payout-recovery.service';
import { ReferralsService } from '../referrals/referrals.service';
import { ReferralAccount } from '../referrals/entities/referral-account.entity';
import {
  ReferralWithdrawal,
  ReferralWithdrawalStatus,
} from '../referrals/entities/referral-withdrawal.entity';
import { PayoutRetry, PayoutRetryKind } from './entities/payout-retry.entity';
import {
  PaymentTransaction,
  PaymentProvider,
  PaymentStatus,
  PaymentMethod,
  PaymentPurpose,
} from './entities/payment-transaction.entity';
import { claimDriverPayoutPayment } from './flexpay-payout-state';
import { claimReferralPayoutPayment } from './referral-payout-claim';
import { TripPaymentMode } from './enums/trip-payment-mode.enum';

const bin = process.env.PAYOUT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'Super admin payout retry on isolated PostgreSQL (no provider requests)',
  () => {
    jest.setTimeout(90_000);
    const cluster = new IsolatedPostgres(bin!);
    const migration = new PayoutRetries1780000105000();
    let db: DataSource;
    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
      await db.synchronize();
      await db.query('DROP TABLE payout_retries');
      await db.transaction((manager) => migration.up(manager.queryRunner!));
      await db.transaction((manager) => migration.down(manager.queryRunner!));
      await db.transaction((manager) => migration.up(manager.queryRunner!));
    });
    afterAll(async () => {
      await cluster.stop();
      jest.restoreAllMocks();
    });
    beforeEach(() =>
      db.query('TRUNCATE payout_retries, users, payment_transactions CASCADE'),
    );

    async function fixture(kind: PayoutRetryKind) {
      const user = await db
        .getRepository(User)
        .save({
          firstName: 'Synthetic',
          lastName: 'Recipient',
          status: UserStatus.ACTIVE,
        });
      const admin = await db
        .getRepository(User)
        .save({
          firstName: 'Synthetic',
          lastName: 'Admin',
          role: UserRole.SUPER_ADMIN,
        });
      await db
        .getRepository(KycDocument)
        .save({ userId: user.id, status: KycStatus.APPROVED });
      const common = {
        id: randomUUID(),
        amount: kind === 'driver_payout' ? 10000 : 25000,
        currency: 'CDF',
        phone: '243891234567',
        requestedAt: new Date(Date.now() - 3_600_000),
        idempotencyKey: randomUUID(),
      };
      const original =
        kind === 'driver_payout'
          ? await db
              .getRepository(DriverPayout)
              .save({
                ...common,
                driverId: user.id,
                status: DriverPayoutStatus.PENDING,
              })
          : await db
              .getRepository(ReferralWithdrawal)
              .save({
                ...common,
                userId: user.id,
                tokens: 1000,
                moneyPerToken: 25,
                status: ReferralWithdrawalStatus.PENDING,
              });
      const payment = await db.getRepository(PaymentTransaction).save({
        userId: user.id,
        purpose:
          kind === 'driver_payout'
            ? PaymentPurpose.DRIVER_PAYOUT
            : PaymentPurpose.REFERRAL_PAYOUT,
        relatedEntityType: kind,
        relatedEntityId: original.id,
        provider: PaymentProvider.FLEXPAY,
        method: PaymentMethod.MOBILE_MONEY,
        status: PaymentStatus.PENDING,
        reference: 'SYNTHETIC-ORIGINAL',
        amount: original.amount,
        currency: original.currency,
        phone: original.phone,
      });
      if (kind === 'driver_payout') {
        await db
          .getRepository(DriverPayout)
          .update(original.id, { paymentTransactionId: payment.id });
        await db
          .getRepository(DriverEarning)
          .save({
            driverId: user.id,
            passengerId: randomUUID(),
            bookingId: randomUUID(),
            tripId: randomUUID(),
            paymentMode: TripPaymentMode.ELECTRONIC,
            grossAmount: 10000,
            netAmount: 10000,
            commissionRate: 0,
            commissionAmount: 0,
          });
      } else {
        await db
          .getRepository(ReferralWithdrawal)
          .update(original.id, { paymentTransactionId: payment.id });
        await db
          .getRepository(ReferralAccount)
          .save({
            userId: user.id,
            availableTokens: 0,
            reservedTokens: 1000,
            pendingTokens: 0,
            withdrawnTokens: 0,
          });
      }
      const sent = jest.fn();
      let beforeClaim: (() => Promise<void>) | undefined;
      const payments = {
        findLatestTransactionForRelatedEntity: (type, id, userId) =>
          db.getRepository(PaymentTransaction).findOne({
            where: { relatedEntityType: type, relatedEntityId: id, userId },
            order: { createdAt: 'DESC' },
          }),
        reconcileFlexPayDriverPayout: (id) =>
          db.getRepository(PaymentTransaction).findOneByOrFail({ id }),
        checkPaymentStatus: jest.fn(() => {
          throw new Error('No real provider lookup in isolated tests');
        }),
        formatLogPayload: () => '[synthetic]',
        formatPaymentLogResponse: () => ({}),
        initiatePayout: jest.fn(async (input) => {
          await beforeClaim?.();
          const draft = db
            .getRepository(PaymentTransaction)
            .create({
              ...input,
              reference: `TEST-${randomUUID()}`,
              provider: PaymentProvider.FLEXPAY,
              method: PaymentMethod.MOBILE_MONEY,
              status: PaymentStatus.PENDING,
            });
          const claimed =
            kind === 'driver_payout'
              ? await claimDriverPayoutPayment(
                  db.getRepository(PaymentTransaction),
                  draft,
                )
              : await claimReferralPayoutPayment(
                  db.getRepository(PaymentTransaction),
                  draft,
                );
          if (!claimed.created) return claimed.payment;
          sent(input);
          await db
            .getRepository(PaymentTransaction)
            .update(claimed.payment.id, { status: PaymentStatus.INITIATED });
          return db
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ id: claimed.payment.id });
        }),
      };
      const config: any = { get: () => undefined };
      const settlements = new DriverSettlementsService(
        db.getRepository(DriverEarning), db.getRepository(DriverPayout), db.getRepository(User),
        db.getRepository(KycDocument), {} as any, {} as any, config, payments as any, db, {} as any,
      );
      Object.assign(settlements, { getPayoutFlexPayCallbackUrl: () => 'https://example.invalid/callback' });
      const recovery = new DriverPayoutRecoveryService(
        db,
        payments as any,
        settlements,
        config,
      );
      const referrals = Object.assign(
        Object.create(ReferralsService.prototype),
        {
          dataSource: db,
          withdrawalRepository: db.getRepository(ReferralWithdrawal),
          configService: config,
          paymentsService: payments,
          WITHDRAWAL_RELATED_ENTITY_TYPE: 'referral_withdrawal',
          logger: new Logger('Synthetic'),
          getWithdrawalCallbackUrl: () => 'https://example.invalid/callback',
        },
      ) as ReferralsService;
      const proof = {
        expectedReference: payment.reference,
        reason: 'Confirmation fictive de non-paiement',
        evidenceReference: 'TEST-NOT-EXECUTED',
        confirmedNotPaid: true as const,
        confirmedNotReceived: true as const,
      };
      const retry = (actor = admin.id, body = proof) =>
        kind === 'driver_payout'
          ? recovery.retry(actor, original.id, body)
          : referrals.retryWithdrawal(actor, original.id, body);
      return {
        user,
        admin,
        original,
        payment,
        retry,
        proof,
        sent,
        payments,
        recovery,
        referrals,
        beforeClaim: (hook: () => Promise<void>) => {
          beforeClaim = hook;
        },
      };
    }

    describe.each<PayoutRetryKind>(['driver_payout', 'referral_withdrawal'])(
      '%s',
      (kind) => {
        it('serializes simultaneous admin retries, preserves value/recipient, and never resends on replay', async () => {
          const f = await fixture(kind);
          const results = await Promise.all(
            Array.from({ length: 4 }, () => f.retry()),
          );
          expect(new Set(results.map((r) => r.id)).size).toBe(1);
          expect(f.sent).toHaveBeenCalledTimes(1);
          expect(f.sent).toHaveBeenCalledWith(
            expect.objectContaining({
              amount: Number(f.original.amount),
              currency: 'CDF',
              userId: f.user.id,
            }),
          );
          expect(f.sent.mock.calls[0][0].phone.replace(/^\+/, '')).toBe(
            f.original.phone,
          );
          const link = await db
            .getRepository(PayoutRetry)
            .findOneByOrFail({ kind, sourceId: f.original.id });
          expect(link).toMatchObject({
            replacementId: results[0].id,
            actorId: f.admin.id,
            evidenceReference: f.proof.evidenceReference,
          });
          expect((await f.retry()).id).toBe(results[0].id);
          expect(f.sent).toHaveBeenCalledTimes(1);
          expect(
            (
              await db
                .getRepository(PaymentTransaction)
                .findOneByOrFail({ id: f.payment.id })
            ).status,
          ).toBe(PaymentStatus.PENDING);
          if (kind === 'referral_withdrawal') {
            expect(
              Number((results[0] as ReferralWithdrawal).moneyPerToken),
            ).toBe(25);
            const account = await db
              .getRepository(ReferralAccount)
              .findOneByOrFail({ userId: f.user.id });
            expect(Number(account.availableTokens)).toBe(0);
            expect(Number(account.reservedTokens)).toBe(1000);
          }
          await expect(
            db.transaction((manager) => migration.down(manager.queryRunner!)),
          ).rejects.toThrow('evidence must be preserved');
        });

        it('denies ordinary admins and incomplete confirmations before releasing funds', async () => {
          const f = await fixture(kind);
          await db
            .getRepository(User)
            .update(f.admin.id, { role: UserRole.ADMIN });
          await expect(f.retry()).rejects.toMatchObject({ status: 403 });
          await db
            .getRepository(User)
            .update(f.admin.id, { role: UserRole.SUPER_ADMIN });
          await expect(
            f.retry(f.admin.id, {
              ...f.proof,
              confirmedNotReceived: false as any,
            }),
          ).rejects.toMatchObject({ status: 400 });
          await expect(
            f.retry(f.admin.id, { ...f.proof, evidenceReference: '' }),
          ).rejects.toMatchObject({ status: 400 });
          expect(f.sent).not.toHaveBeenCalled();
          expect(await db.getRepository(PayoutRetry).count()).toBe(0);
        });

        it('refuses a changed reference or an original payment already confirmed successful', async () => {
          const f = await fixture(kind);
          await expect(
            f.retry(f.admin.id, {
              ...f.proof,
              expectedReference: 'ANOTHER-PAYMENT',
            }),
          ).rejects.toMatchObject({ status: 409 });
          await db
            .getRepository(PaymentTransaction)
            .update(f.payment.id, { status: PaymentStatus.SUCCEEDED });
          await expect(f.retry()).rejects.toMatchObject({ status: 409 });
          expect(f.sent).not.toHaveBeenCalled();
        });

        it('fences a late success recorded after reservation but before submission', async () => {
          const f = await fixture(kind);
          f.beforeClaim(async () => {
            await db
              .getRepository(PaymentTransaction)
              .update(f.payment.id, { status: PaymentStatus.SUCCEEDED });
          });
          await expect(f.retry()).rejects.toMatchObject({ status: 400 });
          expect(f.sent).not.toHaveBeenCalled();
          expect(await db.getRepository(PaymentTransaction).count()).toBe(1);
          expect(await db.getRepository(PayoutRetry).count()).toBe(1);
        });

        it('retains a durable attempted payout on a lost response and never submits it again', async () => {
          const f = await fixture(kind);
          const submit = f.payments.initiatePayout.getMockImplementation()!;
          f.payments.initiatePayout.mockImplementation(async (input) => {
            await submit(input);
            throw new Error('Synthetic response loss');
          });
          const first = await f.retry();
          expect((await f.retry()).id).toBe(first.id);
          expect(f.sent).toHaveBeenCalledTimes(1);
          expect(first.status).toBe('initiated');
        });

        it('does not reuse released funds that were already spent elsewhere', async () => {
          const f = await fixture(kind);
          if (kind === 'driver_payout') {
            await f.recovery.resolveNotPaid(f.admin.id, f.original.id, f.proof);
            await db
              .getRepository(DriverPayout)
              .save({
                driverId: f.user.id,
                amount: 10000,
                currency: 'CDF',
                phone: f.original.phone,
                idempotencyKey: randomUUID(),
                status: DriverPayoutStatus.SUCCEEDED,
              });
          } else {
            await f.referrals.resolveWithdrawalNotPaid(
              f.admin.id,
              f.original.id,
              f.proof,
            );
            await db
              .getRepository(ReferralAccount)
              .update({ userId: f.user.id }, { availableTokens: 0 });
          }
          await expect(f.retry()).rejects.toMatchObject({ status: 400 });
          expect(f.sent).not.toHaveBeenCalled();
          expect(await db.getRepository(PayoutRetry).count()).toBe(0);
        });

        it('checks the whole retry chain when an older attempt succeeds late', async () => {
          const f = await fixture(kind);
          const replacement = await f.retry();
          const payment = await db
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ relatedEntityId: replacement.id });
          await db
            .getRepository(PaymentTransaction)
            .update(payment.id, { status: PaymentStatus.FAILED });
          const failed = await db
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ id: payment.id });
          if (kind === 'driver_payout')
            await (f.recovery as any).settlements.applyPaymentToPayout(failed);
          else await (f.referrals as any).applyPaymentToWithdrawal(failed);
          await db
            .getRepository(PaymentTransaction)
            .update(f.payment.id, { status: PaymentStatus.SUCCEEDED });
          const proof = { ...f.proof, expectedReference: payment.reference };
          await expect(
            kind === 'driver_payout'
              ? f.recovery.retry(f.admin.id, replacement.id, proof)
              : f.referrals.retryWithdrawal(f.admin.id, replacement.id, proof),
          ).rejects.toMatchObject({ status: 400 });
          expect(f.sent).toHaveBeenCalledTimes(1);
          expect(await db.getRepository(PayoutRetry).count()).toBe(1);
        });
      },
    );
  },
);
