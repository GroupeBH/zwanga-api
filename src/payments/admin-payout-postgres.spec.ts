import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  PaymentTransaction,
  PaymentPurpose,
  PaymentProvider,
  PaymentStatus,
} from './entities/payment-transaction.entity';
import { PaymentsService } from './payments.service';
import { PaymentSettlementRegistry } from './payment-settlement.registry';
import { AdminDirectPayouts1780000109000 } from '../database/migrations/1780000109000-AdminDirectPayouts';
import { PaymentGatewayUnavailableError } from './payment-provider.policy';

const bin = process.env.PAYOUT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'Treasury payouts on isolated PostgreSQL; no network',
  () => {
    jest.setTimeout(120000);
    const cluster = new IsolatedPostgres(bin!);
    const migration = new AdminDirectPayouts1780000109000();
    let db: DataSource;
    beforeAll(async () => {
      for (const method of ['log', 'warn', 'error', 'debug'] as const)
        jest
          .spyOn(Logger.prototype, method)
          .mockImplementation(() => undefined);
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
      await db.synchronize();
      await db.query(`CREATE TABLE payment_settlement_jobs (
      "paymentId" uuid PRIMARY KEY REFERENCES payment_transactions(id), "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
      revision integer NOT NULL DEFAULT 0, "completedAt" timestamptz, "lastError" varchar(100))`);
      await db.transaction((m) => migration.up(m.queryRunner!));
      await db.transaction((m) => migration.down(m.queryRunner!));
      await db.transaction((m) => migration.up(m.queryRunner!));
    });
    afterAll(async () => {
      await cluster.stop();
      jest.restoreAllMocks();
    });
    beforeEach(() => db.query('TRUNCATE users, payment_transactions CASCADE'));
    async function fixture() {
      const actor = await db
        .getRepository(User)
        .save({
          firstName: 'Treasury',
          lastName: 'Synthetic',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          status: UserStatus.ACTIVE,
        });
      const registry = new PaymentSettlementRegistry();
      const input = {
        userId: actor.id,
        purpose: PaymentPurpose.ADMIN_PAYOUT,
        relatedEntityType: 'admin_direct_payout',
        relatedEntityId: randomUUID(),
        amount: 10000,
        phone: '+243891234567',
        currency: 'CDF',
        description: 'Test treasury transfer',
        preferredProvider: PaymentProvider.FLEXPAY,
      };
      const flex = {
        initiatePayout: jest
          .fn()
          .mockResolvedValue({
            code: '0',
            status: '0XX0',
            orderNumber: 'test-order',
            raw: {},
          }),
        isSuccessfulCode: (code: string) => code === '0',
        checkPayoutTransaction: jest.fn(),
        checkTransaction: jest.fn(),
      };
      const pawa = { isConfigured: () => true, initiatePayout: jest.fn() };
      const settings = {
        PAYMENT_ENABLED_PROVIDERS: 'flexpay,pawapay',
        PAWAPAY_PAYOUTS_ENABLED: 'true',
        PUBLIC_API_BASE_URL: 'https://api.example.invalid/api/v1',
      };
      const payments = new PaymentsService(
        db.getRepository(PaymentTransaction),
        { get: (key: string) => settings[key] } as any,
        flex as any,
        pawa as any,
        registry,
      );
      return { actor, input, flex, pawa, payments };
    }
    it('serializes simultaneous requests and replays without a second provider send', async () => {
      const f = await fixture();
      const result = await Promise.all(
        Array.from({ length: 4 }, () => f.payments.initiatePayout(f.input)),
      );
      expect(new Set(result.map((p) => p.id)).size).toBe(1);
      expect(f.flex.initiatePayout).toHaveBeenCalledTimes(1);
      expect(f.pawa.initiatePayout).not.toHaveBeenCalled();
      const record = await db
        .getRepository(PaymentTransaction)
        .findOneByOrFail({ id: result[0].id });
      expect(record.status).toBe(PaymentStatus.INITIATED);
      expect(record.reference.length).toBeLessThanOrEqual(25);
      expect(record.userId).toBe(f.actor.id);
      expect(record.description).toBe(f.input.description);
      await f.payments.initiatePayout(f.input);
      expect(f.flex.initiatePayout).toHaveBeenCalledTimes(1);
      expect(
        await db.query('SELECT * FROM payment_settlement_jobs'),
      ).toHaveLength(1);
    });
    it('a reused key with changed recipient, amount or reason is rejected', async () => {
      const f = await fixture();
      await f.payments.initiatePayout(f.input);
      for (const patch of [
        { phone: '+243891234568' },
        { amount: 12000 },
        { description: 'Another transfer' },
      ])
        await expect(
          f.payments.initiatePayout({ ...f.input, ...patch }),
        ).rejects.toMatchObject({ status: 409 });
      expect(f.flex.initiatePayout).toHaveBeenCalledTimes(1);
    });
    it('authorization is rechecked inside the claim before any network send', async () => {
      const f = await fixture();
      for (const patch of [
        { role: UserRole.ADMIN },
        { role: UserRole.SUPER_ADMIN, isActive: false },
        { isActive: true, status: UserStatus.SUSPENDED },
        { status: UserStatus.ACTIVE, passwordChangeRequired: true },
      ]) {
        await db.getRepository(User).update(f.actor.id, patch);
        await expect(f.payments.initiatePayout(f.input)).rejects.toMatchObject({
          status: 403,
        });
      }
      expect(f.flex.initiatePayout).not.toHaveBeenCalled();
      expect(await db.getRepository(PaymentTransaction).count()).toBe(0);
    });
    it('lost replies stay pending and never fall back to another provider or resend', async () => {
      const f = await fixture();
      f.flex.initiatePayout.mockRejectedValue(
        new PaymentGatewayUnavailableError(PaymentProvider.FLEXPAY, 'timeout', {
          retryable: true,
          uncertainDelivery: true,
        }),
      );
      const first = await f.payments.initiatePayout(f.input);
      expect(first.status).toBe(PaymentStatus.PENDING);
      expect((await f.payments.initiatePayout(f.input)).id).toBe(first.id);
      expect(f.flex.initiatePayout).toHaveBeenCalledTimes(1);
      expect(f.pawa.initiatePayout).not.toHaveBeenCalled();
      expect(await f.payments.reconcilePayment(first.id)).toBe(false);
    });
    it('uses payout status checks, validates proof and never credits a user wallet', async () => {
      const f = await fixture();
      const first = await f.payments.initiatePayout(f.input);
      f.flex.checkPayoutTransaction.mockResolvedValue({
        code: '0',
        raw: {},
        transaction: {
          reference: 'wrong',
          orderNumber: 'test-order',
          status: '0',
        },
      });
      await expect(f.payments.reconcilePayment(first.id)).rejects.toMatchObject(
        { status: 400 },
      );
      f.flex.checkPayoutTransaction.mockResolvedValue({
        code: '0',
        raw: {},
        transaction: {
          reference: first.reference,
          orderNumber: first.orderNumber,
          status: '0',
          amount: null,
          currency: null,
        },
      });
      expect(await f.payments.reconcilePayment(first.id)).toBe(true);
      const saved = await db
        .getRepository(PaymentTransaction)
        .findOneByOrFail({ id: first.id });
      expect(saved.status).toBe(PaymentStatus.SUCCEEDED);
      expect(f.flex.checkTransaction).not.toHaveBeenCalled();
      expect(f.flex.initiatePayout).toHaveBeenCalledTimes(1);
      for (const table of [
        'wallet_ledger_entries',
        'driver_payouts',
        'referral_withdrawals',
      ])
        expect(
          await db.query(`SELECT count(*)::int AS count FROM ${table}`),
        ).toEqual([{ count: 0 }]);
    });
    it('rollback preserves financial records and migration can reapply without duplicate jobs', async () => {
      const f = await fixture();
      const first = await f.payments.initiatePayout(f.input);
      await db.transaction((m) => migration.down(m.queryRunner!));
      expect(
        await db.getRepository(PaymentTransaction).findOneBy({ id: first.id }),
      ).not.toBeNull();
      await db.transaction((m) => migration.up(m.queryRunner!));
      expect(
        await db.query('SELECT * FROM payment_settlement_jobs'),
      ).toHaveLength(1);
    });
  },
);
