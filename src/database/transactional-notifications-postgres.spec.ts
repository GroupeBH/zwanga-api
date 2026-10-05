import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { typeOrmEntities } from './entities';
import { AddTransactionalNotifications1780000047000 } from './migrations/1780000047000-AddTransactionalNotifications';
import { TransactionalNotificationsSubscriber } from '../notifications/transactional-notifications.subscriber';
import { enqueueTransactionalNotification } from '../notifications/transactional-notification';
import {
  Notification,
  NotificationStatus,
} from '../notifications/entities/notification.entity';
import { NotificationService } from '../notifications/notifications.service';
import { WalletAccount } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry } from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';
import { UserRole } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';

// Explicit opt-in: fresh disposable loopback cluster, never an app URL or .env.
const pgBin = process.env.NOTIFICATIONS_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'transactional push outbox on isolated PostgreSQL',
  () => {
    let directory: string,
      started = false,
      source: DataSource;
    const userId = randomUUID(),
      adminId = randomUUID(),
      accountId = randomUUID();
    const executable = (name: string) =>
      join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);
    const migration = new AddTransactionalNotifications1780000047000();
    let wallet: WalletService;
    let notifications: NotificationService;
    let users: { findOne: jest.Mock; update: jest.Mock };

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-notifications-test-'));
      execFileSync(
        executable('initdb'),
        [
          '-D',
          directory,
          '-U',
          'notifications_test',
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
        username: 'notifications_test',
        database: 'postgres',
        entities: typeOrmEntities,
        synchronize: false,
        extra: { max: 8 },
      });
      await source.initialize();
      await source.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id), "fcmToken" varchar NOT NULL,
        title varchar NOT NULL, body text NOT NULL, data jsonb, "isAutomatic" boolean DEFAULT false,
        status varchar DEFAULT 'pending', "errorMessage" text, "messageId" varchar,
        "isRead" boolean DEFAULT false, "readAt" timestamp, "isActive" boolean DEFAULT true,
        "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now());
      CREATE TABLE wallet_accounts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL REFERENCES users(id), type varchar NOT NULL,
        balance numeric(12,2) DEFAULT 0 CHECK (balance >= 0), "withdrawableBalance" numeric(12,2) DEFAULT 0,
        "reservedWithdrawalBalance" numeric(12,2) DEFAULT 0, "withdrawalsBlocked" boolean DEFAULT false,
        currency varchar DEFAULT 'PTS', "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now(),
        UNIQUE ("userId",type));
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "accountId" uuid REFERENCES wallet_accounts(id), "userId" uuid REFERENCES users(id),
        "accountType" varchar, type varchar, amount numeric(12,2), "withdrawableAmount" numeric(12,2), "balanceAfter" numeric(12,2),
        currency varchar, "relatedEntityType" varchar, "relatedEntityId" uuid, "paymentTransactionId" uuid,
        description varchar(500), "createdAt" timestamp DEFAULT now());
      CREATE TABLE kyc_documents (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id),
        "cniFrontUrl" varchar, "cniFrontUrls" jsonb, "cniBackUrl" varchar, "selfieUrl" varchar,
        status varchar DEFAULT 'pending', provider varchar DEFAULT 'legacy', "rejectionReason" text,
        "reviewedBy" uuid, "reviewedAt" timestamp, "documentNumber" varchar,
        "diditSessionId" varchar, "diditSessionNumber" integer, "diditWorkflowId" varchar,
        "diditVendorData" varchar, "diditSessionStatus" varchar, "diditLastSyncedAt" timestamp, "providerMetadata" jsonb,
        "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now());`);
      const runner = source.createQueryRunner();
      try {
        await migration.up(runner);
      } finally {
        await runner.release();
      }
      new TransactionalNotificationsSubscriber(source);
      users = {
        findOne: jest.fn(async ({ where }) => ({
          id: where.id,
          role:
            where.id === adminId ? UserRole.SUPER_ADMIN : UserRole.PASSENGER,
          fcmToken: 'ExpoPushToken[test-device]',
        })),
        update: jest.fn(),
      };
      wallet = new WalletService(
        source.getRepository(WalletAccount),
        source.getRepository(WalletLedgerEntry),
        users as any,
        source,
        {} as any,
        {} as any,
      );
      notifications = new NotificationService(
        { get: jest.fn() } as any,
        source.getRepository(Notification),
        users as any,
        {} as any,
      );
      await source.query('INSERT INTO users (id) VALUES ($1), ($2)', [
        userId,
        adminId,
      ]);
    }, 60_000);

    beforeEach(async () => {
      await source.query(
        'TRUNCATE notifications, wallet_ledger_entries, wallet_accounts, kyc_documents',
      );
      await source.query(
        "INSERT INTO wallet_accounts (id,\"userId\",type,balance,currency) VALUES ($1,$2,'points',100,'PTS')",
        [accountId, userId],
      );
    });

    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
      try {
        if (source?.isInitialized) await source.destroy();
      } finally {
        if (
          started ||
          (directory && existsSync(join(directory, 'postmaster.pid')))
        )
          execFileSync(
            executable('pg_ctl'),
            ['-D', directory, '-m', 'fast', '-w', 'stop'],
            { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
          );
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-notifications-test-',
          )
        )
          rmSync(directory, { recursive: true, force: true });
      }
    });

    const event = (eventKey: string) => ({
      eventKey,
      userId,
      title: 'Solde ajusté',
      body: '25 jetons ajoutés.',
      data: { type: 'wallet_admin_adjustment' },
    });

    it('atomically adjusts the real wallet ledger and creates exactly one outbox row for concurrent admin retries', async () => {
      const requestId = randomUUID();
      await Promise.all(
        [1, 2].map(() =>
          wallet.applyAdminAdjustment(
            adminId,
            userId,
            25,
            'Correction de solde de test',
            requestId,
          ),
        ),
      );
      expect(
        Number(
          (
            await source
              .getRepository(WalletAccount)
              .findOneByOrFail({ id: accountId })
          ).balance,
        ),
      ).toBe(125);
      expect(await source.getRepository(WalletLedgerEntry).count()).toBe(1);
      expect(await source.getRepository(Notification).count()).toBe(1);
      expect(
        await source.getRepository(Notification).findOneByOrFail({ userId }),
      ).toMatchObject({
        status: 'pending',
        isAutomatic: false,
        data: { amount: 25, balanceAfter: 125 },
      });
    });

    it('does not notify a rejected debit and preserves the original balance', async () => {
      await expect(
        wallet.applyAdminAdjustment(
          adminId,
          userId,
          -200,
          'Correction de solde de test',
          randomUUID(),
        ),
      ).rejects.toThrow('insuffisant');
      expect(await source.getRepository(Notification).count()).toBe(0);
      expect(
        Number(
          (
            await source
              .getRepository(WalletAccount)
              .findOneByOrFail({ id: accountId })
          ).balance,
        ),
      ).toBe(100);
    });

    it('hides the notification until COMMIT and removes it on ROLLBACK', async () => {
      const runner = source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await enqueueTransactionalNotification(
          runner.manager,
          event('rollback'),
        );
        expect(await source.getRepository(Notification).count()).toBe(0);
        expect(await runner.manager.count(Notification)).toBe(1);
        await runner.rollbackTransaction();
        expect(await source.getRepository(Notification).count()).toBe(0);
      } finally {
        await runner.release();
      }
    });

    it('rolls back the financial write if outbox persistence fails', async () => {
      // Fail the outbox INSERT only; real balance/ledger SQL must be rolled back.
      const subscriber = source
        .subscribers[0] as TransactionalNotificationsSubscriber;
      jest
        .spyOn(subscriber, 'afterInsert')
        .mockImplementation(async (event: any) => {
          if (event.metadata.target === WalletLedgerEntry)
            throw new Error('outbox unavailable');
        });
      await expect(
        wallet.applyAdminAdjustment(
          adminId,
          userId,
          25,
          'Correction de solde de test',
          randomUUID(),
        ),
      ).rejects.toThrow('outbox unavailable');
      expect(await source.getRepository(WalletLedgerEntry).count()).toBe(0);
      expect(
        Number(
          (
            await source
              .getRepository(WalletAccount)
              .findOneByOrFail({ id: accountId })
          ).balance,
        ),
      ).toBe(100);
    });

    it('deduplicates concurrent producers using the database unique key', async () => {
      await Promise.all(
        [1, 2, 3].map(() =>
          source.transaction((manager) =>
            enqueueTransactionalNotification(manager, event('same-event')),
          ),
        ),
      );
      expect(await source.getRepository(Notification).count()).toBe(1);
    });

    it('claims outbox rows once across two ECS-style workers', async () => {
      await source.transaction((manager) =>
        enqueueTransactionalNotification(manager, event('dispatch')),
      );
      const second = new NotificationService(
        { get: jest.fn() } as any,
        source.getRepository(Notification),
        users as any,
        {} as any,
      );
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: { status: 'ok', id: 'ticket' } }),
      } as Response);
      await Promise.all([
        notifications.dispatchTransactionalNotifications(),
        second.dispatchTransactionalNotifications(),
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(
        await source
          .getRepository(Notification)
          .findOneByOrFail({ eventKey: 'dispatch' }),
      ).toMatchObject({ status: NotificationStatus.SENT });
    });

    it('retains a failed push for retry without undoing the committed financial operation', async () => {
      await wallet.applyAdminAdjustment(
        adminId,
        userId,
        25,
        'Correction de solde de test',
        randomUUID(),
      );
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('provider unavailable'));
      await notifications.dispatchTransactionalNotifications();
      expect(
        (await source.getRepository(Notification).findOneByOrFail({ userId }))
          .status,
      ).toBe(NotificationStatus.FAILED);
      expect(
        Number(
          (
            await source
              .getRepository(WalletAccount)
              .findOneByOrFail({ id: accountId })
          ).balance,
        ),
      ).toBe(125);
    });

    it('queues a manual KYC approval on a real ORM status change and not on an unchanged save', async () => {
      const repo = source.getRepository(KycDocument);
      const document = await repo.save(
        repo.create({ userId, status: KycStatus.PENDING }),
      );
      expect(await source.getRepository(Notification).count()).toBe(0);
      await source.transaction(async (manager) => {
        document.status = KycStatus.APPROVED;
        document.reviewedBy = adminId;
        document.reviewedAt = new Date();
        await manager.save(document);
      });
      await repo.save(document);
      expect(await source.getRepository(Notification).count()).toBe(1);
      expect(
        await source.getRepository(Notification).findOneByOrFail({ userId }),
      ).toMatchObject({ data: { type: 'kyc_approved' } });
    });

    it('does not notify an approval rolled back with its business transaction', async () => {
      const repo = source.getRepository(KycDocument);
      const document = await repo.save(
        repo.create({ userId, status: KycStatus.PENDING }),
      );
      await expect(
        source.transaction(async (manager) => {
          document.status = KycStatus.APPROVED;
          document.reviewedBy = adminId;
          document.reviewedAt = new Date();
          await manager.save(document);
          throw new Error('business rollback');
        }),
      ).rejects.toThrow('business rollback');
      expect((await repo.findOneByOrFail({ id: document.id })).status).toBe(
        KycStatus.PENDING,
      );
      expect(await source.getRepository(Notification).count()).toBe(0);
    });

    it('refuses a rollback that would erase notification deduplication history', async () => {
      await source.transaction((manager) =>
        enqueueTransactionalNotification(manager, event('keep-history')),
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

    it('rejects a non-atomic insert before changing the ledger', async () => {
      await expect(
        source.getRepository(WalletLedgerEntry).insert({
          accountId,
          userId,
          amount: 10,
          balanceAfter: 110,
        }),
      ).rejects.toThrow('require a transaction');
      expect(await source.getRepository(WalletLedgerEntry).count()).toBe(0);
    });

    it('rejects partial KYC state updates before committing a notification-less approval', async () => {
      const repository = source.getRepository(KycDocument);
      const document = await repository.save(
        repository.create({ userId, status: KycStatus.PENDING }),
      );
      await expect(
        repository.update(document.id, {
          status: KycStatus.APPROVED,
          reviewedBy: adminId,
        }),
      ).rejects.toThrow('transactional save()');
      expect(
        (await repository.findOneByOrFail({ id: document.id })).status,
      ).toBe(KycStatus.PENDING);
      expect(await source.getRepository(Notification).count()).toBe(0);
    });
  },
);
