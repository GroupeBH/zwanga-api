import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { walletMovementNotification } from '../notifications/financial-notification.policy';
import { WalletLedgerEntry } from '../wallet/entities/wallet-ledger-entry.entity';
import { UserRole } from '../users/entities/user.entity';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { DataSource } from 'typeorm';
import { postgresTestServerOptions } from '../../test/postgres-test-options';
import { AddVerifiedWelcomeBonus1780000052000 } from './migrations/1780000052000-AddVerifiedWelcomeBonus';
import { DriverWelcomeBonusCopy1780000059000 } from './migrations/1780000059000-DriverWelcomeBonusCopy';
import { IsolateWelcomeBonusFailures1780000063000 } from './migrations/1780000063000-IsolateWelcomeBonusFailures';
import { WelcomeBonus25CdfCopy1780000071000 } from './migrations/1780000071000-WelcomeBonus25CdfCopy';
import { WelcomeBonus200Tokens1780000072000 } from './migrations/1780000072000-WelcomeBonus200Tokens';
import { WelcomeBonus500Tokens1780000081000 } from './migrations/1780000081000-WelcomeBonus500Tokens';

// Only a throwaway cluster on a random loopback port. No application env/DB URL.
const bin = process.env.WELCOME_BONUS_TEST_POSTGRES_BIN ?? process.env.WALLET_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  '200-token welcome bonus on isolated PostgreSQL',
  () => {
    let directory: string, db: DataSource, oldDefinition: string;
    const exe = (name: string) =>
      join(bin!, process.platform === 'win32' ? `${name}.exe` : name);

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-welcome-200-test-'));
      execFileSync(
        exe('initdb'),
        [
          '-D',
          directory,
          '-U',
          'welcome_bonus_test',
          '-A',
          'trust',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { windowsHide: true, stdio: 'pipe', timeout: 30000 },
      );
      const port = await new Promise<number>((done, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string')
            return reject(new Error('No local port'));
          server.close(() => done(address.port));
        });
      });
      execFileSync(
        exe('pg_ctl'),
        [
          '-D',
          directory,
          '-l',
          join(directory, 'postgres.log'),
          '-o',
          postgresTestServerOptions(port),
          '-w',
          'start',
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 30000 },
      );
      db = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'welcome_bonus_test',
        database: 'postgres',
        extra: { max: 6 },
      });
      await db.initialize();
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users (id uuid PRIMARY KEY, role text DEFAULT 'driver', status text DEFAULT 'active',
        "isActive" boolean DEFAULT true, password text DEFAULT 'old-hash', "lastLoginAt" timestamp,
        "refreshToken" text DEFAULT 'old-refresh', "accessToken" text DEFAULT 'old-access');
      CREATE TABLE kyc_documents (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id),
        status text DEFAULT 'approved', "createdAt" timestamp DEFAULT now());
      CREATE TABLE wallet_accounts (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id),
        type text, currency text NOT NULL DEFAULT 'PTS', balance numeric(12,2) NOT NULL DEFAULT 0,
        "withdrawableBalance" numeric(12,2) DEFAULT 0, "updatedAt" timestamp DEFAULT now(), UNIQUE ("userId",type));
      CREATE TABLE wallet_ledger_entries (id uuid PRIMARY KEY, "accountId" uuid REFERENCES wallet_accounts(id), "userId" uuid,
        "accountType" text, type text, amount numeric(12,2), "withdrawableAmount" numeric(12,2), "balanceAfter" numeric(12,2),
        currency text, "relatedEntityType" text, "relatedEntityId" uuid, description text);
      CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "eventKey" text UNIQUE,
        "userId" uuid REFERENCES users(id), "fcmToken" text, title text, body text, data jsonb,
        "isAutomatic" boolean, status text, "errorMessage" text);`);
      for (const migration of [
        new AddVerifiedWelcomeBonus1780000052000(),
        new DriverWelcomeBonusCopy1780000059000(),
        new IsolateWelcomeBonusFailures1780000063000(),
        new WelcomeBonus25CdfCopy1780000071000(),
      ])
        await db.transaction((m) => migration.up(m.queryRunner!));
      [{ definition: oldDefinition }] = await db.query(
        "SELECT pg_get_functiondef('zwanga_grant_welcome_bonus(uuid)'::regprocedure) AS definition",
      );
    }, 60000);

    afterAll(async () => {
      try {
        if (db?.isInitialized) await db.destroy();
      } finally {
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-welcome-200-test-',
          )
        ) {
          if (existsSync(join(directory, 'postmaster.pid')))
            execFileSync(
              exe('pg_ctl'),
              ['-D', directory, '-m', 'fast', '-w', 'stop'],
              { windowsHide: true, stdio: 'pipe', timeout: 30000 },
            );
          rmSync(directory, { recursive: true, force: true });
        }
      }
    });

    beforeEach(async () => {
      await db.query(
        'TRUNCATE notifications,wallet_ledger_entries,welcome_bonus_grants,welcome_bonus_retry_state,kyc_documents,wallet_accounts,users',
      );
      // Restore the actual previous deployment definition in this disposable DB.
      await db.query(oldDefinition);
      await db.query(`ALTER TABLE welcome_bonus_grants
        DROP CONSTRAINT welcome_bonus_grants_amount_check,
        ADD CONSTRAINT welcome_bonus_grants_amount_check CHECK (amount = 50),
        ALTER COLUMN amount SET DEFAULT 50`);
    });

    const upgrade = () =>
      db.transaction((m) =>
        new WelcomeBonus200Tokens1780000072000().up(m.queryRunner!),
      );
    const backfill = () =>
      db.query('SELECT zwanga_backfill_welcome_bonus(100) AS credited');
    const grant = (id: string) =>
      db.query('SELECT zwanga_grant_welcome_bonus($1) AS credited', [id]);
    const wallet = async (id: string) =>
      (
        await db.query('SELECT * FROM wallet_accounts WHERE "userId"=$1', [id])
      )[0];
    const claims = () => db.query('SELECT * FROM welcome_bonus_grants');
    const entries = () => db.query('SELECT * FROM wallet_ledger_entries');
    const notices = () => db.query('SELECT * FROM notifications');

    async function candidate(currency = 'PTS', role = 'driver') {
      const id = randomUUID();
      await db.transaction(async (m) => {
        await m.query('INSERT INTO users(id,role) VALUES ($1,$2)', [id, role]);
        await m.query(
          `INSERT INTO wallet_accounts("userId",type,currency,balance,"withdrawableBalance")
          VALUES ($1,'points',$2,70,20)`,
          [id, currency],
        );
        await m.query(
          `INSERT INTO kyc_documents("userId",status) VALUES ($1,'pending')`,
          [id],
        );
      });
      return id;
    }
    const approve = (id: string) =>
      db.query(`UPDATE kyc_documents SET status='approved' WHERE "userId"=$1`, [
        id,
      ]);

    async function unclaimed(currency = 'PTS', role = 'driver') {
      const id = await candidate(currency, role);
      // Fixture only: model a validated user missed by a previous deployment.
      await db.transaction(async (m) => {
        await m.query(
          'ALTER TABLE kyc_documents DISABLE TRIGGER kyc_verified_welcome_bonus',
        );
        await m.query(
          `UPDATE kyc_documents SET status='approved' WHERE "userId"=$1`,
          [id],
        );
        await m.query(
          'ALTER TABLE kyc_documents ENABLE TRIGGER kyc_verified_welcome_bonus',
        );
      });
      return id;
    }

    it('keeps a historical 50-token credit and notification unchanged with no top-up', async () => {
      const id = await candidate();
      await approve(id);
      const previous = {
        wallet: await wallet(id),
        claims: await claims(),
        entries: await entries(),
        notices: await notices(),
      };
      expect(previous.claims[0].amount).toBe('50.00');
      await upgrade();
      expect(await grant(id)).toEqual([{ credited: false }]);
      expect(await backfill()).toEqual([{ credited: 0 }]);
      // Changing a former passenger/driver role also cannot issue another bonus.
      await db.query("UPDATE users SET role='passenger' WHERE id=$1", [id]);
      expect({
        wallet: await wallet(id),
        claims: await claims(),
        entries: await entries(),
        notices: await notices(),
      }).toEqual(previous);
    });

    it('recovers a legacy ledger-only credit as 50, not as the new default 200', async () => {
      const id = await candidate();
      await approve(id);
      await db.query('DELETE FROM welcome_bonus_grants WHERE "userId"=$1', [
        id,
      ]);
      const previous = {
        wallet: await wallet(id),
        entries: await entries(),
        notices: await notices(),
      };
      await upgrade();
      expect(await backfill()).toEqual([{ credited: 0 }]);
      expect(await claims()).toMatchObject([{ userId: id, amount: '50.00' }]);
      expect({
        wallet: await wallet(id),
        entries: await entries(),
        notices: await notices(),
      }).toEqual(previous);
      expect(await grant(id)).toEqual([{ credited: false }]);
    });

    it.each(['PTS', 'POINTS'])(
      'credits exactly 200 promotional tokens and a matching outbox row (%s)',
      async (currency) => {
        await upgrade();
        const id = await candidate(currency);
        await approve(id);
        expect(await wallet(id)).toMatchObject({
          balance: '270.00',
          withdrawableBalance: '20.00',
          currency,
        });
        expect(await claims()).toMatchObject([
          { userId: id, amount: '200.00' },
        ]);
        const ledger = (await entries())[0];
        expect(ledger).toMatchObject({
          amount: '200.00',
          withdrawableAmount: '0.00',
          currency,
        });
        const notice = (await notices())[0];
        expect(notice.body).toBe(
          walletMovementNotification(
            ledger as WalletLedgerEntry,
            UserRole.DRIVER,
          )!.body,
        );
        expect(notice).toMatchObject({
          status: 'pending',
          eventKey: `wallet:${ledger.id}`,
          data: {
            amount: 200,
            currency,
            balanceAfter: 270,
            type: 'wallet_loyalty_reward',
          },
        });
        expect(await grant(id)).toEqual([{ credited: false }]);
        expect(await backfill()).toEqual([{ credited: 0 }]);
        expect(await entries()).toHaveLength(1);
        expect(await notices()).toHaveLength(1);
      },
    );

    it('keeps passenger eligibility and does not pay again on becoming a driver', async () => {
      await upgrade();
      const id = await candidate('PTS', 'passenger');
      await approve(id);
      const notice = (await notices())[0];
      expect(notice.body).toContain('200 jetons de bienvenue');
      expect(notice.body).not.toContain('abonnement Pro');
      await db.query("UPDATE users SET role='driver' WHERE id=$1", [id]);
      expect((await wallet(id)).balance).toBe('270.00');
      expect(await notices()).toHaveLength(1);
    });

    it('does not credit during migration and lets the existing cron catch up once', async () => {
      const id = await unclaimed();
      await upgrade();
      expect((await wallet(id)).balance).toBe('70.00');
      expect(await claims()).toHaveLength(0);
      expect(await notices()).toHaveLength(0);
      expect(await backfill()).toEqual([{ credited: 1 }]);
      expect((await wallet(id)).balance).toBe('270.00');
      expect(await backfill()).toEqual([{ credited: 0 }]);
    });

    it('serializes competing grants and a cron without duplicate credits or pushes', async () => {
      await upgrade();
      const id = await unclaimed();
      await Promise.all([grant(id), grant(id), grant(id), backfill()]);
      expect((await wallet(id)).balance).toBe('270.00');
      expect(await claims()).toHaveLength(1);
      expect(await entries()).toHaveLength(1);
      expect(await notices()).toHaveLength(1);
    });

    it.each(['pending', 'rejected'])(
      'requires an approved latest KYC (%s)',
      async (status) => {
        await upgrade();
        const id = await unclaimed();
        await db.query(
          `INSERT INTO kyc_documents("userId",status,"createdAt") VALUES ($1,$2,now() + interval '1 minute')`,
          [id, status],
        );
        expect(await grant(id)).toEqual([{ credited: false }]);
        expect(await backfill()).toEqual([{ credited: 0 }]);
        expect((await wallet(id)).balance).toBe('70.00');
        expect(await notices()).toHaveLength(0);
      },
    );

    it.each(['inactive', 'suspended', 'admin'])(
      'does not grant to an ineligible account (%s)',
      async (reason) => {
        await upgrade();
        const id = await candidate();
        if (reason === 'inactive')
          await db.query('UPDATE users SET "isActive"=false WHERE id=$1', [id]);
        if (reason === 'suspended')
          await db.query("UPDATE users SET status='suspended' WHERE id=$1", [
            id,
          ]);
        if (reason === 'admin')
          await db.query("UPDATE users SET role='admin' WHERE id=$1", [id]);
        await approve(id);
        expect(await grant(id)).toEqual([{ credited: false }]);
        expect(await backfill()).toEqual([{ credited: 0 }]);
        expect((await wallet(id)).balance).toBe('70.00');
        expect(await notices()).toHaveLength(0);
      },
    );

    it('rolls back credit/ledger/claim when the outbox fails, then retries once', async () => {
      await upgrade();
      const id = await candidate();
      await db.query(
        'ALTER TABLE notifications ADD CONSTRAINT fixture_fail CHECK (false) NOT VALID',
      );
      try {
        await approve(id); // KYC approval itself must succeed.
        expect((await wallet(id)).balance).toBe('70.00');
        expect(await claims()).toHaveLength(0);
        expect(await entries()).toHaveLength(0);
        expect(await notices()).toHaveLength(0);
        expect(
          await db.query('SELECT attempts FROM welcome_bonus_retry_state'),
        ).toEqual([{ attempts: 1 }]);
      } finally {
        await db.query(
          'ALTER TABLE notifications DROP CONSTRAINT fixture_fail',
        );
      }
      expect(await backfill()).toEqual([{ credited: 0 }]);
      await db.query(
        `UPDATE welcome_bonus_retry_state SET "nextAttemptAt"=now() - interval '1 second'`,
      );
      expect(await backfill()).toEqual([{ credited: 1 }]);
      expect((await wallet(id)).balance).toBe('270.00');
      expect(await entries()).toHaveLength(1);
      expect(await notices()).toHaveLength(1);
    });

    it('still isolates invalid wallet currencies from KYC approval and PIN writes', async () => {
      await upgrade();
      const id = await candidate('CDF');
      await approve(id);
      await db.query("UPDATE users SET password='new-hash' WHERE id=$1", [id]);
      expect((await wallet(id)).balance).toBe('70.00');
      expect(
        await db.query('SELECT password FROM users WHERE id=$1', [id]),
      ).toEqual([{ password: 'new-hash' }]);
      expect(await entries()).toHaveLength(0);
      expect(
        await db.query(
          'SELECT attempts,"lastErrorCode" FROM welcome_bonus_retry_state',
        ),
      ).toEqual([
        { attempts: 1, lastErrorCode: 'WELCOME_BONUS_INVALID_WALLET_CURRENCY' },
      ]);
    });

    it('allows historical 50 and new 200 claims but rejects other grant amounts', async () => {
      const id = await candidate();
      await approve(id);
      await upgrade();
      await expect(
        db.query(
          'UPDATE welcome_bonus_grants SET amount=100 WHERE "userId"=$1',
          [id],
        ),
      ).rejects.toThrow('welcome_bonus_grants_amount_check');
      expect((await claims())[0].amount).toBe('50.00');
      expect(
        await db.query(`SELECT column_default FROM information_schema.columns
        WHERE table_name='welcome_bonus_grants' AND column_name='amount'`),
      ).toEqual([{ column_default: '200' }]);
    });

    it('grants 500 only to new beneficiaries and preserves historical 50/200 balances and notices', async () => {
      const old50 = await candidate();
      await approve(old50);
      await upgrade();
      const old200 = await candidate();
      await approve(old200);
      const missed = await unclaimed();
      const fresh = await candidate();
      const previous = {
        old50: await wallet(old50), old200: await wallet(old200),
        entries: await entries(), notices: await notices(),
      };
      await db.transaction(m => new WelcomeBonus500Tokens1780000081000().up(m.queryRunner!));
      expect(await entries()).toEqual(previous.entries);
      expect(await notices()).toEqual(previous.notices);
      expect(await wallet(old50)).toEqual(previous.old50);
      expect(await wallet(old200)).toEqual(previous.old200);
      await approve(fresh);
      await Promise.all([grant(missed), grant(missed), backfill()]);
      expect((await wallet(fresh)).balance).toBe('570.00');
      expect((await wallet(missed)).balance).toBe('570.00');
      expect((await wallet(fresh)).withdrawableBalance).toBe('20.00');
      expect(await claims()).toHaveLength(4);
      expect(await entries()).toHaveLength(4);
      expect(await notices()).toHaveLength(4);
      const freshEntry = (await entries()).find((entry: any) => entry.userId === fresh);
      const freshNotice = (await notices()).find((notice: any) => notice.userId === fresh);
      expect(freshEntry.amount).toBe('500.00');
      expect(freshNotice.body).toBe(walletMovementNotification(freshEntry, UserRole.DRIVER)!.body);
      expect(freshNotice.body).toContain('5 000 FC');
      expect(freshNotice.data.amount).toBe(500);
      expect(await grant(old50)).toEqual([{ credited: false }]);
      expect(await grant(old200)).toEqual([{ credited: false }]);
    });
  },
);
