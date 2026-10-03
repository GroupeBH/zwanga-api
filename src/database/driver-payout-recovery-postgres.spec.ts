import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { typeOrmEntities } from './entities';
import { AddDriverPayoutRecovery1780000046000 } from './migrations/1780000046000-AddDriverPayoutRecovery';
import { DriverPayoutRecoveryService } from '../driver-settlements/driver-payout-recovery.service';
import { DriverSettlementsService } from '../driver-settlements/driver-settlements.service';
import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { DriverPayoutEvent } from '../driver-settlements/entities/driver-payout-event.entity';
import {
  PaymentTransaction,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import {
  claimDriverPayoutPayment,
  commitFlexPayPayoutState,
} from '../payments/flexpay-payout-state';

// Explicit opt-in. New disposable cluster only; never reads .env or an application DB URL.
const pgBin = process.env.PAYOUT_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'driver payout recovery on isolated PostgreSQL',
  () => {
    let directory: string,
      started = false,
      source: DataSource;
    let recovery: DriverPayoutRecoveryService,
      settlements: DriverSettlementsService;
    const driver = randomUUID(),
      admin = randomUUID(),
      payoutId = randomUUID(),
      paymentId = randomUUID();
    const executable = (name: string) =>
      join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);
    const migration = new AddDriverPayoutRecovery1780000046000();
    const dto = {
      expectedReference: 'TEST-REF',
      confirmedNotPaid: true as const,
      reason: 'Confirmation définitive fictive pour test isolé',
      evidenceReference: 'TEST-FLEX-NOT-PAID',
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      directory = mkdtempSync(join(tmpdir(), 'zwanga-payout-recovery-test-'));
      execFileSync(
        executable('initdb'),
        [
          '-D',
          directory,
          '-U',
          'payout_test',
          '-A',
          'trust',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { windowsHide: true, stdio: 'pipe', timeout: 30_000 },
      );
      const port = await new Promise<number>((done) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          server.close(() => done(port));
        });
      });
      execFileSync(
        executable('pg_ctl'),
        [
          '-D',
          directory,
          '-l',
          join(directory, 'postgres.log'),
          '-o',
          `-h 127.0.0.1 -p ${port}`,
          '-w',
          'start',
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
      );
      started = true;
      source = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'payout_test',
        database: 'postgres',
        entities: typeOrmEntities,
        synchronize: false,
        extra: { max: 5 },
      });
      await source.initialize();
      await source.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE payment_transactions (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid, purpose varchar(80),
        "relatedEntityType" varchar(80), "relatedEntityId" varchar(80), provider varchar(20), method varchar(20),
        status varchar(20), reference varchar(120) UNIQUE, "orderNumber" varchar(120), "providerReference" varchar(120),
        "providerStatusCode" varchar(32), "providerMessage" varchar(500), amount numeric(10,2), currency varchar(8),
        description varchar(500), phone varchar(30), "paymentUrl" varchar(1000), "callbackUrl" varchar(1000),
        "rawInitiationResponse" jsonb, "rawCallbackPayload" jsonb, "rawCheckResponse" jsonb, "paidAt" timestamp,
        "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now());
      CREATE TABLE driver_payouts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "driverId" uuid, "idempotencyKey" varchar(80),
        amount numeric(12,2), currency varchar(8), phone varchar(30), status varchar(40),
        "paymentTransactionId" uuid REFERENCES payment_transactions(id), "requestedAt" timestamp,
        "processedAt" timestamp, "failureReason" varchar(500), "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now());
      CREATE TABLE driver_earnings (id uuid PRIMARY KEY, "driverId" uuid, "netAmount" numeric(12,2), status varchar(20));`);
      const runner = source.createQueryRunner();
      await migration.up(runner);
      await runner.release();
      await source.query('INSERT INTO users VALUES ($1),($2)', [driver, admin]);
      const payments: any = {
        findLatestTransactionForRelatedEntity: async (_type, id, userId) =>
          source
            .getRepository(PaymentTransaction)
            .findOne({ where: { relatedEntityId: id, userId } }),
        reconcileFlexPayDriverPayout: async (id) =>
          source.getRepository(PaymentTransaction).findOneByOrFail({ id }),
      };
      const config: any = { get: () => undefined };
      settlements = new DriverSettlementsService(
        {} as any,
        source.getRepository(DriverPayout),
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        config,
        payments,
        source,
        {} as any,
      );
      recovery = new DriverPayoutRecoveryService(
        source,
        payments,
        settlements,
        config,
      );
    }, 60_000);

    beforeEach(async () => {
      await source.query('DELETE FROM driver_payout_events');
      await source.query('DELETE FROM driver_payouts');
      await source.query('DELETE FROM payment_transactions');
      await source.query('DELETE FROM driver_earnings');
      await source.query(
        `INSERT INTO driver_earnings VALUES ($1,$2,10000,'available')`,
        [randomUUID(), driver],
      );
      await source.query(
        `INSERT INTO payment_transactions (id,"userId",purpose,"relatedEntityType","relatedEntityId",provider,method,status,reference,amount,currency)
      VALUES ($1,$2,'driver_payout','driver_payout',$3,'flexpay','mobile_money','pending','TEST-REF',9500,'CDF')`,
        [paymentId, driver, payoutId],
      );
      await source.query(
        `INSERT INTO driver_payouts (id,"driverId","idempotencyKey",amount,currency,phone,status,"paymentTransactionId","requestedAt")
      VALUES ($1,$2,'KEY',9500,'CDF','+243891234567','pending',$3,now()-interval '14 days')`,
        [payoutId, driver, paymentId],
      );
    });

    afterAll(async () => {
      try {
        if (source?.isInitialized) await source.destroy();
      } finally {
        if (started)
          execFileSync(
            executable('pg_ctl'),
            ['-D', directory, '-m', 'fast', '-w', 'stop'],
            { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
          );
        // Guard the exact disposable directory before recursive cleanup.
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-payout-recovery-test-',
          )
        ) {
          rmSync(directory, { recursive: true, force: true });
        }
        jest.restoreAllMocks();
      }
    });

    it('commits a single release and audit entry for two simultaneous support requests', async () => {
      const results = await Promise.all([
        recovery.resolveNotPaid(admin, payoutId, dto),
        recovery.resolveNotPaid(admin, payoutId, dto),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        'cancelled',
        'cancelled',
      ]);
      expect(await source.getRepository(DriverPayoutEvent).count()).toBe(1);
      expect(
        await (settlements as any).getAvailableBalanceWithManager(
          source.manager,
          driver,
        ),
      ).toBe(10000);
    });

    it('late verified success is retained, debits available gains and blocks withdrawals until reviewed', async () => {
      await recovery.resolveNotPaid(admin, payoutId, dto);
      const repository = source.getRepository(PaymentTransaction);
      const payment = await repository.findOneByOrFail({ id: paymentId });
      const success = await commitFlexPayPayoutState(repository, {
        ...payment,
        status: PaymentStatus.SUCCEEDED,
      });
      await Promise.all([
        settlements.applyPaymentToPayout(success),
        settlements.applyPaymentToPayout(success),
      ]);
      const stored = await source
        .getRepository(DriverPayout)
        .findOneByOrFail({ id: payoutId });
      expect(stored).toMatchObject({
        status: 'succeeded',
        recoveryBlocked: true,
      });
      expect(
        await source
          .getRepository(DriverPayoutEvent)
          .countBy({ action: 'late_success' }),
      ).toBe(1);
      expect(await (settlements as any).getAvailableBalance(driver)).toBe(0);
      expect(
        await (settlements as any).getAvailableBalanceWithManager(
          source.manager,
          driver,
        ),
      ).toBe(500);
      await recovery.closeLateSuccessIncident(admin, payoutId, {
        reason: 'Test de rapprochement',
        evidenceReference: 'TEST-RECONCILED',
      });
      expect(
        (
          await source
            .getRepository(DriverPayout)
            .findOneByOrFail({ id: payoutId })
        ).status,
      ).toBe('succeeded');
    });

    it('claims only one provider submission under concurrent retries', async () => {
      const repository = source.getRepository(PaymentTransaction);
      const draft = await repository.findOneByOrFail({ id: paymentId });
      await source.query(
        'UPDATE driver_payouts SET "paymentTransactionId"=NULL WHERE id=$1',
        [payoutId],
      );
      await repository.delete(paymentId);
      const results = await Promise.all([
        claimDriverPayoutPayment(repository, draft),
        claimDriverPayoutPayment(repository, draft),
      ]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await repository.count()).toBe(1);
    });

    it('allows release before submission and prevents any subsequent send', async () => {
      const repository = source.getRepository(PaymentTransaction);
      const draft = await repository.findOneByOrFail({ id: paymentId });
      await source.query(
        'UPDATE driver_payouts SET "paymentTransactionId"=NULL WHERE id=$1',
        [payoutId],
      );
      await repository.delete(paymentId);
      await recovery.resolveNotPaid(admin, payoutId, {
        ...dto,
        expectedReference: payoutId,
      });
      await expect(claimDriverPayoutPayment(repository, draft)).rejects.toThrow(
        'ne peut plus',
      );
      expect(await repository.count()).toBe(0);
    });

    it('lists stale or order-less requests and refuses audit-destructive rollback', async () => {
      expect((await recovery.list({ limit: 50, offset: 0 })).data).toHaveLength(
        1,
      );
      await recovery.requestReview(
        driver,
        payoutId,
        'Non reçu depuis deux semaines',
      );
      const runner = source.createQueryRunner();
      try {
        await expect(migration.down(runner)).rejects.toThrow(
          'rollback refused',
        );
      } finally {
        await runner.release();
      }
    });
  },
);
