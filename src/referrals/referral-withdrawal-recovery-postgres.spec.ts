import { randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { ReferralWithdrawalResolution1780000090000 } from '../database/migrations/1780000090000-ReferralWithdrawalResolution';
import { User, UserRole } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { claimReferralPayoutPayment } from '../payments/referral-payout-claim';
import { TransactionalNotificationsSubscriber } from '../notifications/transactional-notifications.subscriber';
import { Notification } from '../notifications/entities/notification.entity';
import { ReferralAccount } from './entities/referral-account.entity';
import {
  ReferralWithdrawal,
  ReferralWithdrawalStatus,
} from './entities/referral-withdrawal.entity';
import { ReferralWithdrawalResolution } from './entities/referral-withdrawal-resolution.entity';
import {
  ReferralLedgerEntry,
  ReferralLedgerEntryType,
} from './entities/referral-ledger-entry.entity';
import { ReferralsService } from './referrals.service';

// Opt-in disposable loopback cluster. No application config, provider HTTP or real push.
const bin =
  process.env.REFERRAL_TEST_POSTGRES_BIN ??
  process.env.PAYOUT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'Referral withdrawal release on isolated PostgreSQL',
  () => {
    jest.setTimeout(90_000);
    const cluster = new IsolatedPostgres(bin!);
    const migration = new ReferralWithdrawalResolution1780000090000();
    let db: DataSource;
    let service: ReferralsService;
    let subscriber: TransactionalNotificationsSubscriber;
    let payments: any;
    const proof = {
      expectedReference: 'REF-SYNTHETIC',
      confirmedNotPaid: true as const,
      reason: 'Non-exécution définitive fictive',
      evidenceReference: 'FICTITIOUS-CONFIRMATION',
    };

    beforeAll(async () => {
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query(
        'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
      );
      await db.synchronize();
      await db.query('DROP TABLE referral_withdrawal_resolutions');
      await db.transaction((manager) => migration.up(manager.queryRunner!));
      await db.transaction((manager) => migration.down(manager.queryRunner!));
      await db.transaction((manager) => migration.up(manager.queryRunner!));
      subscriber = new TransactionalNotificationsSubscriber(db);
    });
    afterAll(async () => {
      subscriber?.onModuleDestroy();
      await cluster.stop();
    });
    beforeEach(async () => {
      await db.query(
        'TRUNCATE users, payment_transactions, notifications CASCADE',
      );
      payments = {
        initiatePayout: jest.fn(() => {
          throw new Error('No transfer may be submitted by recovery');
        }),
        checkPaymentStatus: jest.fn((orderNumber, userId) =>
          db
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ orderNumber, userId }),
        ),
        reconcilePayment: jest.fn().mockResolvedValue(false),
        findTransactionById: jest.fn((id) =>
          db.getRepository(PaymentTransaction).findOneByOrFail({ id }),
        ),
      };
      service = Object.assign(Object.create(ReferralsService.prototype), {
        dataSource: db,
        paymentsService: payments,
        withdrawalRepository: db.getRepository(ReferralWithdrawal),
        WITHDRAWAL_RELATED_ENTITY_TYPE: 'referral_withdrawal',
        configService: { get: () => undefined },
      });
    });
    const balance = (userId: string) =>
      db.getRepository(ReferralAccount).findOneByOrFail({ userId });
    const reload = (id: string) =>
      db.getRepository(ReferralWithdrawal).findOneByOrFail({ id });
    const apply = (payment: PaymentTransaction) =>
      (service as any).applyPaymentToWithdrawal(payment);

    async function fixture(withPayment = true) {
      const user = await db
        .getRepository(User)
        .save({ firstName: 'Synthetic', lastName: 'Referrer' });
      const admin = await db.getRepository(User).save({
        firstName: 'Synthetic',
        lastName: 'Admin',
        role: UserRole.SUPER_ADMIN,
      });
      await db.getRepository(ReferralAccount).save({
        userId: user.id,
        availableTokens: 500,
        reservedTokens: 1000,
        pendingTokens: 80,
        withdrawnTokens: 25,
        currency: 'PTS',
      });
      const withdrawal = await db.getRepository(ReferralWithdrawal).save({
        userId: user.id,
        tokens: 1000,
        amount: 10000,
        moneyPerToken: 10,
        currency: 'CDF',
        phone: '+243891234567',
        requestedAt: new Date(Date.now() - 14 * 86400000),
        status: ReferralWithdrawalStatus.PENDING,
        idempotencyKey: randomUUID(),
      });
      const draft = db.getRepository(PaymentTransaction).create({
        userId: user.id,
        provider: PaymentProvider.FLEXPAY,
        purpose: PaymentPurpose.REFERRAL_PAYOUT,
        relatedEntityType: 'referral_withdrawal',
        relatedEntityId: withdrawal.id,
        reference: proof.expectedReference,
        orderNumber: 'ORDER-SYNTHETIC',
        amount: 10000,
        currency: 'CDF',
        phone: withdrawal.phone,
        status: PaymentStatus.PENDING,
        method: PaymentMethod.MOBILE_MONEY,
      });
      const payment = withPayment
        ? (
            await claimReferralPayoutPayment(
              db.getRepository(PaymentTransaction),
              draft,
            )
          ).payment
        : null;
      return { user, admin, withdrawal, payment: payment!, draft };
    }

    it('releases once under concurrent admin requests, preserving payment status, audit and one push', async () => {
      const { user, admin, withdrawal, payment } = await fixture();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof),
        ),
      );
      expect(
        results.every(
          (row) => row.status === ReferralWithdrawalStatus.CANCELLED,
        ),
      ).toBe(true);
      expect(await balance(user.id)).toMatchObject({
        availableTokens: '1500.00',
        reservedTokens: '0.00',
        pendingTokens: '80.00',
        withdrawnTokens: '25.00',
      });
      expect(
        (
          await db
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ id: payment.id })
        ).status,
      ).toBe(PaymentStatus.PENDING);
      expect(
        await db.getRepository(ReferralWithdrawalResolution).find(),
      ).toEqual([
        expect.objectContaining({
          withdrawalId: withdrawal.id,
          actorId: admin.id,
          evidenceReference: proof.evidenceReference,
        }),
      ]);
      expect(
        await db.getRepository(ReferralLedgerEntry).countBy({
          withdrawalId: withdrawal.id,
          type: ReferralLedgerEntryType.WITHDRAWAL_REFUNDED,
        }),
      ).toBe(2);
      expect(
        await db.getRepository(Notification).countBy({
          eventKey: `referral-withdrawal:${withdrawal.id}:cancelled`,
        }),
      ).toBe(1);
      expect(payments.initiatePayout).not.toHaveBeenCalled();
    });

    it('does not refund an uncertain submitted transfer during reconciliation, even after two weeks', async () => {
      const { user, withdrawal } = await fixture();
      await service.recoverUnsentWithdrawal(withdrawal.id);
      expect((await reload(withdrawal.id)).status).toBe(
        ReferralWithdrawalStatus.PENDING,
      );
      expect(await balance(user.id)).toMatchObject({
        availableTokens: '500.00',
        reservedTokens: '1000.00',
      });
      expect(await db.getRepository(ReferralWithdrawalResolution).count()).toBe(
        0,
      );
    });

    it('allows out-of-band definitive proof during a check outage, without re-sending', async () => {
      const { admin, withdrawal } = await fixture();
      payments.checkPaymentStatus.mockRejectedValue(
        new BadGatewayException('Synthetic outage'),
      );
      expect(
        (await service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof))
          .status,
      ).toBe('cancelled');
      expect(payments.initiatePayout).not.toHaveBeenCalled();
    });

    it('allows definitive proof during an authentication outage, without inventing a provider failure', async () => {
      const { admin, withdrawal, payment } = await fixture();
      payments.checkPaymentStatus.mockRejectedValue(
        new BadRequestException({ code: 'PAYOUT_SERVICE_UNAVAILABLE' }),
      );
      expect(
        (await service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof))
          .status,
      ).toBe('cancelled');
      expect(
        (
          await db
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ id: payment.id })
        ).status,
      ).toBe('pending');
    });

    it.each([
      'reference',
      'proof',
      'recent',
      'amount',
      'phone',
      'provider',
      'missing-payment',
      'reserved-balance',
    ])('refuses unsafe release: %s', async (scenario) => {
      const { user, admin, withdrawal, payment } = await fixture();
      let dto = { ...proof };
      if (scenario === 'reference') dto.expectedReference = 'WRONG';
      if (scenario === 'proof') dto.evidenceReference = '';
      if (scenario === 'recent') {
        withdrawal.requestedAt = new Date();
        await db.getRepository(ReferralWithdrawal).save(withdrawal);
      }
      if (
        scenario === 'amount' ||
        scenario === 'phone' ||
        scenario === 'provider'
      ) {
        await db.getRepository(PaymentTransaction).save({
          ...payment,
          ...(scenario === 'amount'
            ? { amount: 9000 }
            : scenario === 'phone'
              ? { phone: '+243891234568' }
              : { provider: PaymentProvider.PAWAPAY }),
        });
      }
      if (scenario === 'missing-payment')
        await db
          .getRepository(PaymentTransaction)
          .save({ ...payment, relatedEntityId: randomUUID() });
      if (scenario === 'reserved-balance')
        await db
          .getRepository(ReferralAccount)
          .update({ userId: user.id }, { reservedTokens: 5 });
      await expect(
        service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, dto),
      ).rejects.toThrow();
      expect((await balance(user.id)).availableTokens).toBe('500.00');
      expect(await db.getRepository(ReferralWithdrawalResolution).count()).toBe(
        0,
      );
      expect(await db.getRepository(ReferralLedgerEntry).count()).toBe(0);
    });

    it('refuses a success discovered by the provider check before release', async () => {
      const { admin, user, withdrawal, payment } = await fixture();
      await db
        .getRepository(PaymentTransaction)
        .save({ ...payment, status: PaymentStatus.SUCCEEDED });
      await expect(
        service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof),
      ).rejects.toThrow('confirmé');
      expect((await reload(withdrawal.id)).status).toBe('succeeded');
      expect(await balance(user.id)).toMatchObject({
        availableTokens: '500.00',
        reservedTokens: '0.00',
        withdrawnTokens: '1025.00',
      });
      expect(await db.getRepository(ReferralWithdrawalResolution).count()).toBe(
        0,
      );
    });

    it('prevents provider submission after release of an unsent reservation', async () => {
      const { admin, withdrawal, draft } = await fixture(false);
      await service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, {
        ...proof,
        expectedReference: withdrawal.id,
      });
      await expect(
        claimReferralPayoutPayment(db.getRepository(PaymentTransaction), draft),
      ).rejects.toThrow('envoyé');
      expect(await db.getRepository(PaymentTransaction).count()).toBe(0);
    });

    it('handles missing order numbers with definitive evidence and never invents a provider status', async () => {
      const { admin, withdrawal, payment } = await fixture();
      await db
        .getRepository(PaymentTransaction)
        .save({ ...payment, orderNumber: null });
      await service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof);
      expect(payments.checkPaymentStatus).not.toHaveBeenCalled();
      expect(
        (
          await db
            .getRepository(PaymentTransaction)
            .findOneByOrFail({ id: payment.id })
        ).status,
      ).toBe('pending');
    });

    it('keeps cancellation on stale pending, but debits late success exactly once even after tokens are reserved again', async () => {
      const { admin, user, withdrawal, payment } = await fixture();
      await service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof);
      await apply(payment);
      expect((await reload(withdrawal.id)).status).toBe('cancelled');
      // Use the real reservation code for the next intent; never submit a real payout.
      await db
        .getRepository(KycDocument)
        .save({ userId: user.id, status: KycStatus.APPROVED });
      await (service as any).reserveWithdrawal({
        userId: user.id,
        tokens: 1000,
        amount: 10000,
        currency: 'CDF',
        moneyPerToken: 10,
        phone: withdrawal.phone,
        idempotencyKey: randomUUID(),
      });
      const succeeded = await db
        .getRepository(PaymentTransaction)
        .save({ ...payment, status: PaymentStatus.SUCCEEDED });
      await Promise.all([apply(succeeded), apply(succeeded), apply(payment)]);
      expect(await balance(user.id)).toMatchObject({
        availableTokens: '-500.00',
        reservedTokens: '1000.00',
        withdrawnTokens: '1025.00',
      });
      expect((await reload(withdrawal.id)).status).toBe('succeeded');
      expect(await db.getRepository(ReferralWithdrawalResolution).count()).toBe(
        1,
      );
      expect(
        await db.getRepository(ReferralLedgerEntry).countBy({
          withdrawalId: withdrawal.id,
          type: ReferralLedgerEntryType.WITHDRAWAL_SUCCEEDED,
        }),
      ).toBe(2);
      expect(
        await db.getRepository(Notification).countBy({
          eventKey: `referral-withdrawal:${withdrawal.id}:succeeded`,
        }),
      ).toBe(1);
      await expect(
        service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof),
      ).rejects.toThrow('confirmé');
    });

    it('rolls back the release, evidence and notification together if the ledger write fails', async () => {
      const { admin, user, withdrawal } = await fixture();
      const spy = jest
        .spyOn(service as any, 'createLedgerEntry')
        .mockRejectedValueOnce(new Error('Synthetic ledger failure'));
      try {
        await expect(
          service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof),
        ).rejects.toThrow('ledger failure');
      } finally {
        spy.mockRestore();
      }
      expect(await balance(user.id)).toMatchObject({
        availableTokens: '500.00',
        reservedTokens: '1000.00',
      });
      expect((await reload(withdrawal.id)).status).toBe('pending');
      expect(await db.getRepository(ReferralWithdrawalResolution).count()).toBe(
        0,
      );
      expect(
        await db.getRepository(Notification).countBy({
          eventKey: `referral-withdrawal:${withdrawal.id}:cancelled`,
        }),
      ).toBe(0);
    });

    it('refuses rollback that would erase resolution evidence', async () => {
      const { admin, withdrawal } = await fixture();
      await service.resolveWithdrawalNotPaid(admin.id, withdrawal.id, proof);
      await expect(
        db.transaction((manager) => migration.down(manager.queryRunner!)),
      ).rejects.toThrow('evidence must be preserved');
      expect(await db.getRepository(ReferralWithdrawalResolution).count()).toBe(
        1,
      );
    });
  },
);
