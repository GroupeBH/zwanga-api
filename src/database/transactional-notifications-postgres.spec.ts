import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { typeOrmEntities } from './entities';
import { AddTransactionalNotifications1780000047000 } from './migrations/1780000047000-AddTransactionalNotifications';
import { HardenPushOwnershipAndPriority1780000051000 } from './migrations/1780000051000-HardenPushOwnershipAndPriority';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
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
import { KycDocument, KycProvider, KycStatus } from '../users/entities/kyc-document.entity';
import { ReferralsService } from '../referrals/referrals.service';
import { ReferralProfile } from '../referrals/entities/referral-profile.entity';
import { ReferralAccount } from '../referrals/entities/referral-account.entity';
import { ReferralLedgerEntry } from '../referrals/entities/referral-ledger-entry.entity';

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
    let referrals: ReferralsService;
    let notifications: NotificationService;
    let users: { findOne: jest.Mock; update: jest.Mock; count: jest.Mock };

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
      CREATE TABLE users (id uuid PRIMARY KEY, "firstName" varchar DEFAULT 'Test', "fcmToken" varchar,
        "isActive" boolean DEFAULT true, status varchar DEFAULT 'active', "updatedAt" timestamp DEFAULT now());
      CREATE TABLE driver_notification_clients ("userId" uuid PRIMARY KEY, "tokenHash" varchar);
      CREATE TABLE app_update_clients ("userId" uuid PRIMARY KEY, "tokenHash" varchar);
      CREATE TABLE trips (id uuid PRIMARY KEY, "driverId" uuid, status varchar, "tripRequestId" uuid);
      CREATE TABLE bookings (id uuid PRIMARY KEY, "tripId" uuid, status varchar);
      CREATE TABLE referral_profiles (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid UNIQUE REFERENCES users(id), code varchar(16) UNIQUE,
        "linkToken" varchar(64) UNIQUE, "shareLinkUrl" varchar(500), "shareLinkGeneratedAt" timestamp,
        "referredByUserId" uuid REFERENCES users(id), "referredAt" timestamp, "attributionProvider" varchar(30),
        "attributionLinkToken" varchar(64), "attributionReferringLink" varchar(500), "attributionCapturedAt" timestamp,
        "qualifiedAt" timestamp, "rewardWindowEndsAt" timestamp, "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now());
      CREATE TABLE referral_accounts (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid UNIQUE REFERENCES users(id),
        "pendingTokens" numeric(14,2) DEFAULT 0, "availableTokens" numeric(14,2) DEFAULT 0,
        "reservedTokens" numeric(14,2) DEFAULT 0, "withdrawnTokens" numeric(14,2) DEFAULT 0,
        currency varchar DEFAULT 'PTS', "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now());
      CREATE TABLE referral_ledger_entries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "accountId" uuid REFERENCES referral_accounts(id), "userId" uuid REFERENCES users(id),
        type varchar, bucket varchar, "amountTokens" numeric(14,2), "balanceAfter" numeric(14,2), "rewardId" uuid,
        "withdrawalId" uuid, "paymentTransactionId" uuid, "sourceType" varchar, "sourceEntityId" uuid,
        description varchar(500), "createdAt" timestamp DEFAULT now(), UNIQUE ("userId", type, "sourceType", "sourceEntityId"));
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
        "reservedCashCommissionBalance" numeric(12,2) DEFAULT 0,
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
        await runner.startTransaction();
        await new HardenPushOwnershipAndPriority1780000051000().up(runner);
        await runner.commitTransaction();
      } finally {
        await runner.release();
      }
      new TransactionalNotificationsSubscriber(source);
      users = {
        count: jest.fn().mockResolvedValue(1),
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
        { get: jest.fn() } as any,
        {} as any,
      );
      referrals = new ReferralsService({} as any, {} as any, {} as any, {} as any, {} as any,
        users as any, {} as any, {} as any, source, { get: jest.fn() } as any,
        {} as any, {} as any, {} as any);
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
        'TRUNCATE notifications, wallet_ledger_entries, wallet_accounts, kyc_documents, referral_profiles, referral_accounts, referral_ledger_entries',
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

    it('a token transfer notifies both users once after commit through the actual outbox dispatcher', async () => {
      users.findOne.mockResolvedValueOnce({ id: adminId, firstName: 'Recipient', lastName: 'Test', isActive: true });
      const send = jest.spyOn(notifications as any, 'sendExpoPushNotification').mockResolvedValue('synthetic-transfer-message');
      const result = await wallet.transferPoints(userId, { recipientUserId: adminId, amount: 25, note: 'Private note not for the lock screen' });
      expect(send).not.toHaveBeenCalled();
      const rows = await source.getRepository(Notification).find();
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ userId, status: 'pending', eventKey: `wallet:${result.senderEntry.id}`,
          data: expect.objectContaining({ type: 'wallet_transfer_out', amount: -25, transferId: result.transferId }) }),
        expect.objectContaining({ userId: adminId, status: 'pending', eventKey: `wallet:${result.recipientEntry.id}`,
          data: expect.objectContaining({ type: 'wallet_transfer_in', amount: 25, transferId: result.transferId }) }),
      ]));
      expect(JSON.stringify(rows)).not.toContain('Private note');
      await source.transaction(async manager => {
        for (const row of rows) await enqueueTransactionalNotification(manager, {
          eventKey: row.eventKey!, userId: row.userId!, title: row.title, body: row.body, data: row.data!,
        });
      });
      expect(await source.getRepository(Notification).count()).toBe(2);
      await notifications.dispatchTransactionalNotifications();
      expect(send).toHaveBeenCalledTimes(2);
      expect(await source.getRepository(Notification).countBy({ status: NotificationStatus.SENT })).toBe(2);
      await notifications.dispatchTransactionalNotifications();
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('rolls back both transfer notifications and balances if the recipient credit fails', async () => {
      users.findOne.mockResolvedValueOnce({ id: adminId, isActive: true });
      await source.query(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT test_transfer_failure CHECK (type <> 'transfer_in') NOT VALID`);
      try {
        await expect(wallet.transferPoints(userId, { recipientUserId: adminId, amount: 25 })).rejects.toThrow('test_transfer_failure');
        expect(await source.getRepository(Notification).count()).toBe(0);
        expect(await source.getRepository(WalletLedgerEntry).count()).toBe(0);
        expect(Number((await source.getRepository(WalletAccount).findOneByOrFail({ id: accountId })).balance)).toBe(100);
        expect(await source.getRepository(WalletAccount).findOneBy({ userId: adminId })).toBeNull();
      } finally {
        await source.query('ALTER TABLE wallet_ledger_entries DROP CONSTRAINT test_transfer_failure');
      }
    });

    it('does not announce a rejected transfer with insufficient funds', async () => {
      users.findOne.mockResolvedValueOnce({ id: adminId, isActive: true });
      await expect(wallet.transferPoints(userId, { recipientUserId: adminId, amount: 101 })).rejects.toThrow('insuffisant');
      expect(await source.getRepository(Notification).count()).toBe(0);
      expect(await source.getRepository(WalletLedgerEntry).count()).toBe(0);
    });

    it('serializes concurrent device transfers, removes old capabilities and enforces database uniqueness', async () => {
      const a = randomUUID(), b = randomUUID();
      await source.query('INSERT INTO users (id) VALUES ($1), ($2)', [a, b]);
      const service = Object.create(UsersService.prototype);
      service.userRepository = source.getRepository(User);
      service.logger = { debug() {} };
      await service.updateFcmToken(a, 'synthetic-transfer-device');
      await source.query('INSERT INTO driver_notification_clients ("userId", "tokenHash") VALUES ($1, $2)', [a, 'synthetic']);
      await Promise.all([service.updateFcmToken(b, 'synthetic-transfer-device'), service.updateFcmToken(a, 'synthetic-transfer-device')]);
      const owners = await source.query('SELECT id FROM users WHERE "fcmToken" = $1', ['synthetic-transfer-device']);
      expect(owners).toHaveLength(1);
      expect(await source.query('SELECT * FROM driver_notification_clients WHERE "userId" = $1', [a])).toHaveLength(0);
      const other = owners[0].id === a ? b : a;
      await expect(source.query('UPDATE users SET "fcmToken" = $1 WHERE id = $2', ['synthetic-transfer-device', other])).rejects.toMatchObject({ code: '23505' });
    });

    it('migration clears ambiguous historical bindings instead of selecting an arbitrary owner', async () => {
      const runner = source.createQueryRunner(); await runner.startTransaction();
      try {
        await runner.query('DROP INDEX "UQ_users_push_token"');
        await runner.query('DROP INDEX "IDX_notifications_urgent_outbox"');
        await runner.query('UPDATE users SET "fcmToken" = $1 WHERE id IN ($2, $3)', ['ambiguous-device', userId, adminId]);
        await new HardenPushOwnershipAndPriority1780000051000().up(runner);
        const owners = await runner.query('SELECT id FROM users WHERE "fcmToken" = $1', ['ambiguous-device']);
        expect(owners).toHaveLength(0);
      } finally { await runner.rollbackTransaction(); await runner.release(); }
    });

    it('urgent SQL lane bypasses an older campaign and suppresses a booking after cancellation', async () => {
      const tripId = randomUUID(), bookingId = randomUUID();
      await source.query(`INSERT INTO trips (id, "driverId", status) VALUES ($1, $2, 'upcoming')`, [tripId, userId]);
      await source.query(`INSERT INTO bookings (id, "tripId", status) VALUES ($1, $2, 'pending')`, [bookingId, tripId]);
      await source.transaction(async manager => {
        for (let i = 0; i < 30; i++) await enqueueTransactionalNotification(manager, event(`regular:${i}`));
        await enqueueTransactionalNotification(manager, { ...event('booking:urgent'),
          data: { type: 'new_booking', bookingId, driverId: userId, tripId } });
      });
      const send = jest.spyOn(notifications as any, 'sendExpoPushNotification').mockResolvedValue('synthetic-message');
      await notifications.dispatchUrgentNotifications();
      expect(send).toHaveBeenCalledTimes(1);
      expect(await source.getRepository(Notification).countBy({ status: NotificationStatus.PENDING })).toBe(30);
      await source.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]);
      await source.query(`UPDATE notifications SET status = 'failed', "updatedAt" = now() - interval '20 seconds' WHERE "eventKey" = 'booking:urgent'`);
      await notifications.dispatchUrgentNotifications();
      expect(send).toHaveBeenCalledTimes(1);
      expect((await source.getRepository(Notification).findOneByOrFail({ eventKey: 'booking:urgent' })).isActive).toBe(false);
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

    it('creates a first wallet once under concurrent credits and idempotent retries', async () => {
      await source.query('DELETE FROM wallet_accounts WHERE id = $1', [accountId]);
      const requestId = randomUUID();
      await Promise.all([requestId, requestId, randomUUID()].map((id) =>
        wallet.applyAdminAdjustment(adminId, userId, 25, 'Premier crédit manuel de test', id)));
      const account = await source.getRepository(WalletAccount).findOneByOrFail({ userId });
      expect(Number(account.balance)).toBe(50);
      expect(Number(account.withdrawableBalance)).toBe(0);
      expect(await source.getRepository(WalletAccount).count()).toBe(1);
      expect(await source.getRepository(WalletLedgerEntry).count()).toBe(2);
      expect(await source.getRepository(Notification).count()).toBe(2);
    });

    it('keeps an audit and a single referral bonus/push for concurrent administrative retries', async () => {
      const reason = 'Rattachement administratif vérifié';
      const results = await Promise.all([1, 2].map(() => referrals.attachUserByAdmin(adminId, userId, adminId, reason)));
      expect(results.filter((result) => result.newlyAttached)).toHaveLength(1);
      const profile = await source.getRepository(ReferralProfile).findOneByOrFail({ userId });
      expect(profile).toMatchObject({ referredByUserId: adminId, attributionProvider: 'admin', qualifiedAt: null });
      expect(Number((await source.getRepository(ReferralAccount).findOneByOrFail({ userId: adminId })).availableTokens)).toBe(5);
      expect(await source.getRepository(ReferralLedgerEntry).count()).toBe(1);
      expect(await source.getRepository(Notification).count()).toBe(1);
      expect((await source.getRepository(ReferralLedgerEntry).findOneByOrFail({ userId: adminId })).description).toContain(`admin ${adminId} : ${reason}`);
    });

    it('serializes opposing referrals and rolls back the assignment which would create a cycle', async () => {
      const results = await Promise.allSettled([
        referrals.attachUserByAdmin(adminId, userId, adminId, 'Premier rattachement de test'),
        referrals.attachUserByAdmin(adminId, adminId, userId, 'Second rattachement de test'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await source.getRepository(ReferralLedgerEntry).count()).toBe(1);
      expect(await source.getRepository(Notification).count()).toBe(1);
    });

    it('rolls back an administrative attachment if its bonus notification cannot be persisted', async () => {
      const subscriber = source.subscribers[0] as TransactionalNotificationsSubscriber;
      jest.spyOn(subscriber, 'afterInsert').mockImplementation(async (event: any) => {
        if (event.metadata.target === ReferralLedgerEntry) throw new Error('outbox unavailable');
      });
      await expect(referrals.attachUserByAdmin(adminId, userId, adminId, 'Rattachement de test atomique')).rejects.toThrow('outbox unavailable');
      expect(await source.getRepository(ReferralProfile).count()).toBe(0);
      expect(await source.getRepository(ReferralAccount).count()).toBe(0);
      expect(await source.getRepository(ReferralLedgerEntry).count()).toBe(0);
      expect(await source.getRepository(Notification).count()).toBe(0);
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

    it('dispatches a Didit approval once despite sync updates and a later admin confirmation', async () => {
      const repo = source.getRepository(KycDocument);
      const document = await repo.save(repo.create({
        userId, provider: KycProvider.DIDIT, status: KycStatus.PENDING,
        diditSessionId: 'synthetic-session',
      }));
      await source.transaction(async (manager) => {
        document.status = KycStatus.APPROVED;
        document.reviewedBy = null;
        document.reviewedAt = new Date();
        await manager.save(document);
        // The dispatcher, using a different connection, cannot observe this yet.
        expect(await source.getRepository(Notification).count()).toBe(0);
      });
      document.diditLastSyncedAt = new Date();
      await repo.save(document);
      const send = jest.spyOn(notifications as any, 'sendExpoPushNotification').mockResolvedValue('synthetic-kyc');
      await notifications.dispatchTransactionalNotifications();
      document.reviewedBy = adminId; // Same decision, same reviewedAt.
      await repo.save(document);
      await notifications.dispatchTransactionalNotifications();
      expect(await source.getRepository(Notification).count()).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await source.getRepository(Notification).findOneByOrFail({ userId })).toMatchObject({
        status: NotificationStatus.SENT, data: { type: 'kyc_approved' },
      });
    });

    it('retries a failed Didit approval push without undoing the KYC approval', async () => {
      const repo = source.getRepository(KycDocument);
      const document = await repo.save(repo.create({
        userId, provider: KycProvider.DIDIT, status: KycStatus.APPROVED,
        reviewedBy: null, reviewedAt: new Date(),
      }));
      const send = jest.spyOn(notifications as any, 'sendExpoPushNotification')
        .mockRejectedValueOnce(new Error('synthetic provider outage'))
        .mockResolvedValue('synthetic-recovered');
      await notifications.dispatchTransactionalNotifications();
      expect((await repo.findOneByOrFail({ id: document.id })).status).toBe(KycStatus.APPROVED);
      expect(await source.getRepository(Notification).findOneByOrFail({ userId })).toMatchObject({ status: NotificationStatus.FAILED });
      await source.query(`UPDATE notifications SET "updatedAt" = now() - interval '6 minutes' WHERE "userId" = $1`, [userId]);
      await notifications.retryCriticalFinancialNotifications();
      expect(send).toHaveBeenCalledTimes(2);
      expect(await source.getRepository(Notification).count()).toBe(1);
      expect(await source.getRepository(Notification).findOneByOrFail({ userId })).toMatchObject({ status: NotificationStatus.SENT });
    });

    it('suppresses a superseded decision and delivers a new approval on the same KYC', async () => {
      const repo = source.getRepository(KycDocument);
      const document = await repo.save(repo.create({
        userId, provider: KycProvider.DIDIT, status: KycStatus.APPROVED,
        reviewedBy: null, reviewedAt: new Date('2026-10-07T10:00:00Z'),
      }));
      document.status = KycStatus.REJECTED;
      document.reviewedAt = new Date('2026-10-07T10:01:00Z');
      await repo.save(document);
      document.status = KycStatus.APPROVED;
      document.reviewedAt = new Date('2026-10-07T10:02:00Z');
      await repo.save(document);
      const send = jest.spyOn(notifications as any, 'sendExpoPushNotification').mockResolvedValue('synthetic-latest');
      await notifications.dispatchTransactionalNotifications();
      expect(send).toHaveBeenCalledTimes(1);
      const rows = await source.getRepository(Notification).find({ order: { createdAt: 'ASC' } });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ isActive: false, status: NotificationStatus.FAILED });
      expect(rows[1]).toMatchObject({ isActive: true, status: NotificationStatus.SENT });
    });

    it('does not push approval for an older dossier when the latest KYC is pending', async () => {
      const repo = source.getRepository(KycDocument);
      await repo.save(repo.create({
        userId, status: KycStatus.APPROVED, reviewedAt: new Date(),
        createdAt: new Date('2026-10-07T10:00:00Z'),
      }));
      await repo.save(repo.create({
        userId, status: KycStatus.PENDING, createdAt: new Date('2026-10-07T11:00:00Z'),
      }));
      const send = jest.spyOn(notifications as any, 'sendExpoPushNotification').mockResolvedValue('unused');
      await notifications.dispatchTransactionalNotifications();
      expect(send).not.toHaveBeenCalled();
      expect(await source.getRepository(Notification).findOneByOrFail({ userId })).toMatchObject({ isActive: false });
    });

    it.each([adminId, null])('does not notify an approval rolled back with its business transaction (reviewer %s)', async (reviewedBy) => {
      const repo = source.getRepository(KycDocument);
      const document = await repo.save(
        repo.create({ userId, status: KycStatus.PENDING }),
      );
      await expect(
        source.transaction(async (manager) => {
          document.status = KycStatus.APPROVED;
          document.reviewedBy = reviewedBy;
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
