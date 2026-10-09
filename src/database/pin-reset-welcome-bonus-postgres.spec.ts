import { execFileSync } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { BadRequestException, Logger } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth/auth.service';
import { User } from '../users/entities/user.entity';
import { AddVerifiedWelcomeBonus1780000052000 } from './migrations/1780000052000-AddVerifiedWelcomeBonus';
import { PrioritizeDriverWelcomeBonus1780000054000 } from './migrations/1780000054000-PrioritizeDriverWelcomeBonus';
import { DriverWelcomeBonusCopy1780000059000 } from './migrations/1780000059000-DriverWelcomeBonusCopy';
import { IsolateWelcomeBonusFailures1780000063000 } from './migrations/1780000063000-IsolateWelcomeBonusFailures';
import { AddPinResetReplayProtection1780000064000 } from './migrations/1780000064000-AddPinResetReplayProtection';

// Opt-in throwaway cluster, random loopback port. NEVER reads app .env or DB URLs.
const bin = process.env.PIN_RESET_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'PIN reset and welcome bonus on isolated PostgreSQL',
  () => {
    let directory: string, db: DataSource;
    const repair = new IsolateWelcomeBonusFailures1780000063000();
    const exe = (name: string) =>
      join(bin!, process.platform === 'win32' ? `${name}.exe` : name);

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-pin-reset-test-'));
      execFileSync(
        exe('initdb'),
        [
          '-D',
          directory,
          '-U',
          'pin_reset_test',
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
          const port = (server.address() as { port: number }).port;
          server.close(() => done(port));
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
          `-h 127.0.0.1 -p ${port}`,
          '-w',
          'start',
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 30000 },
      );
      // The real AuthService uses the real TypeORM transaction/locks. A minimal
      // schema avoids booting unrelated application modules or external services.
      db = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'pin_reset_test',
        database: 'postgres',
        extra: { max: 6 },
        entities: [
          new EntitySchema<User>({
            name: 'User',
            target: User,
            tableName: 'users',
            columns: {
              id: { type: 'uuid', primary: true },
              role: { type: 'text' },
              status: { type: 'text' },
              isActive: { type: 'boolean' },
              password: { type: 'text', nullable: true, select: false },
              refreshToken: { type: 'text', nullable: true, select: false },
              accessToken: { type: 'text', nullable: true, select: false },
              lastPinResetTokenHash: {
                type: 'text',
                nullable: true,
                select: false,
              },
            },
          }),
        ],
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
        new PrioritizeDriverWelcomeBonus1780000054000(),
        new DriverWelcomeBonusCopy1780000059000(),
      ]) {
        await db.transaction((m) => migration.up(m.queryRunner!));
      }
      // Reproduce the production failure against the original deployed SQL first.
      const legacy = await historicalUser('POINTS');
      await expect(
        db.query('UPDATE users SET password=$2 WHERE id=$1', [
          legacy,
          'new-hash',
        ]),
      ).rejects.toThrow('WELCOME_BONUS_INVALID_WALLET_CURRENCY');
      expect(
        (await db.query('SELECT password FROM users WHERE id=$1', [legacy]))[0]
          .password,
      ).toBe('old-hash');
      await db.transaction((m) => repair.up(m.queryRunner!));
      await db.transaction((m) =>
        new AddPinResetReplayProtection1780000064000().up(m.queryRunner!),
      );
    }, 60000);

    beforeEach(async () => {
      await db.query(
        'TRUNCATE notifications,wallet_ledger_entries,welcome_bonus_grants,welcome_bonus_retry_state,kyc_documents,wallet_accounts,users',
      );
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
      try {
        if (db?.isInitialized) await db.destroy();
      } finally {
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-pin-reset-test-',
          )
        ) {
          if (existsSync(join(directory, 'postmaster.pid')))
            execFileSync(
              exe('pg_ctl'),
              ['-D', directory, '-m', 'fast', '-w', 'stop'],
              { windowsHide: true, stdio: 'ignore', timeout: 30000 },
            );
          rmSync(directory, { recursive: true, force: true });
        }
      }
    });

    // Fixture-only trigger suspension models pre-migration eligible, uncredited users.
    async function historicalUser(
      currency = 'PTS',
      id = randomUUID(),
      role = 'driver',
    ) {
      await db.transaction(async (m) => {
        await m.query(
          'ALTER TABLE kyc_documents DISABLE TRIGGER kyc_verified_welcome_bonus',
        );
        await m.query(
          'ALTER TABLE users DISABLE TRIGGER users_verified_welcome_bonus',
        );
        await m.query('INSERT INTO users(id,role) VALUES ($1,$2)', [id, role]);
        await m.query(
          `INSERT INTO wallet_accounts("userId",type,currency,balance,"withdrawableBalance") VALUES ($1,'points',$2,70,20)`,
          [id, currency],
        );
        await m.query('INSERT INTO kyc_documents("userId") VALUES ($1)', [id]);
        await m.query(
          'ALTER TABLE users ENABLE TRIGGER users_verified_welcome_bonus',
        );
        await m.query(
          'ALTER TABLE kyc_documents ENABLE TRIGGER kyc_verified_welcome_bonus',
        );
      });
      return id;
    }

    const backfill = (size = 100) =>
      db.query('SELECT zwanga_backfill_welcome_bonus($1) AS credited', [size]);
    const wallet = async (id: string) =>
      (
        await db.query('SELECT * FROM wallet_accounts WHERE "userId"=$1', [id])
      )[0];

    it.each(['PTS', 'POINTS', 'CDF'])(
      'allows PIN/session/login writes without invoking a bonus (%s)',
      async (currency) => {
        const id = await historicalUser(currency);
        await db.query(
          'UPDATE users SET password=$2,"accessToken"=NULL,"refreshToken"=NULL,"lastLoginAt"=now() WHERE id=$1',
          [id, 'new-hash'],
        );
        expect(
          (await db.query('SELECT password FROM users WHERE id=$1', [id]))[0]
            .password,
        ).toBe('new-hash');
        expect((await wallet(id)).balance).toBe('70.00');
        expect(
          await db.query('SELECT * FROM welcome_bonus_retry_state'),
        ).toHaveLength(0);
      },
    );

    it.each(['PTS', 'POINTS'])(
      'grants exactly once using the existing %s wallet denomination',
      async (currency) => {
        const id = await historicalUser(currency);
        expect(await backfill()).toEqual([{ credited: 1 }]);
        expect(await backfill()).toEqual([{ credited: 0 }]);
        expect(await wallet(id)).toMatchObject({
          balance: '120.00',
          withdrawableBalance: '20.00',
          currency,
        });
        expect(
          await db.query('SELECT * FROM wallet_ledger_entries'),
        ).toMatchObject([
          { amount: '50.00', withdrawableAmount: '0.00', currency },
        ]);
        const [notice] = await db.query('SELECT * FROM notifications');
        expect(notice.body).toContain('5 000 FC');
        expect(notice.data.currency).toBe(currency);
        expect(
          await db.query('SELECT * FROM welcome_bonus_grants'),
        ).toHaveLength(1);
      },
    );

    it('defers unknown currency without starving the next driver or passenger', async () => {
      const bad = await historicalUser(
        'CDF',
        '00000000-0000-4000-8000-000000000001',
      );
      const good = await historicalUser(
        'POINTS',
        '00000000-0000-4000-8000-000000000002',
      );
      const passenger = await historicalUser('PTS', randomUUID(), 'passenger');
      expect(await backfill(1)).toEqual([{ credited: 0 }]);
      expect(await backfill(1)).toEqual([{ credited: 1 }]);
      expect(await backfill(1)).toEqual([{ credited: 1 }]);
      expect((await wallet(bad)).balance).toBe('70.00');
      expect((await wallet(good)).balance).toBe('120.00');
      expect((await wallet(passenger)).balance).toBe('120.00');
      expect(
        await db.query('SELECT * FROM welcome_bonus_retry_state'),
      ).toMatchObject([
        {
          userId: bad,
          attempts: 1,
          lastErrorCode: 'WELCOME_BONUS_INVALID_WALLET_CURRENCY',
        },
      ]);
      // Only test data is repaired; the migration never converts unknown currencies.
      await db.query(
        `UPDATE wallet_accounts SET currency='PTS' WHERE "userId"=$1`,
        [bad],
      );
      await db.query(
        `UPDATE welcome_bonus_retry_state SET "nextAttemptAt"=now()-interval '1 second'`,
      );
      expect(await backfill()).toEqual([{ credited: 1 }]);
      expect(
        await db.query('SELECT * FROM welcome_bonus_retry_state'),
      ).toHaveLength(0);
    });

    it('keeps account/KYC approvals successful while isolating a bad wallet', async () => {
      const id = await historicalUser('CDF');
      await db.query(
        `UPDATE kyc_documents SET status='pending' WHERE "userId"=$1`,
        [id],
      );
      await db.query(
        `UPDATE kyc_documents SET status='approved' WHERE "userId"=$1`,
        [id],
      );
      await db.query(`UPDATE users SET status='pending_kyc' WHERE id=$1`, [id]);
      await db.query(`UPDATE users SET status='active' WHERE id=$1`, [id]);
      expect(
        (await db.query('SELECT status FROM users WHERE id=$1', [id]))[0]
          .status,
      ).toBe('active');
      expect(await db.query('SELECT * FROM welcome_bonus_grants')).toHaveLength(
        0,
      );
    });

    it('keeps immediate approval grants and defers eligibility until COMMIT', async () => {
      const id = await historicalUser('POINTS');
      await db.transaction(async (m) => {
        await m.query(
          `UPDATE kyc_documents SET status='pending' WHERE "userId"=$1`,
          [id],
        );
        await m.query(
          `UPDATE kyc_documents SET status='approved' WHERE "userId"=$1`,
          [id],
        );
        await m.query(`UPDATE users SET status='suspended' WHERE id=$1`, [id]);
      });
      expect(await db.query('SELECT * FROM welcome_bonus_grants')).toHaveLength(
        0,
      );
      await db.query(`UPDATE users SET status='active' WHERE id=$1`, [id]);
      expect(await db.query('SELECT * FROM welcome_bonus_grants')).toHaveLength(
        1,
      );
    });

    it('rolls back the whole bonus on outbox failure and continues other accounts', async () => {
      const bad = await historicalUser();
      const good = await historicalUser();
      await db.query(
        `ALTER TABLE notifications ADD CONSTRAINT test_outbox_failure CHECK ("userId" <> '${bad}'::uuid)`,
      );
      try {
        expect(await backfill()).toEqual([{ credited: 1 }]);
        expect((await wallet(bad)).balance).toBe('70.00');
        expect((await wallet(good)).balance).toBe('120.00');
        expect(
          await db.query('SELECT * FROM wallet_ledger_entries'),
        ).toHaveLength(1);
        expect(
          await db.query('SELECT * FROM welcome_bonus_grants'),
        ).toHaveLength(1);
        expect(await db.query('SELECT * FROM notifications')).toHaveLength(1);
      } finally {
        await db.query(
          'ALTER TABLE notifications DROP CONSTRAINT test_outbox_failure',
        );
      }
    });

    it('preserves all historical data when reapplying the repair', async () => {
      const id = await historicalUser('POINTS');
      await backfill();
      const previous = await db.query('SELECT * FROM wallet_ledger_entries');
      const notices = await db.query('SELECT * FROM notifications');
      await db.transaction((m) => repair.up(m.queryRunner!));
      expect(await db.query('SELECT * FROM wallet_ledger_entries')).toEqual(
        previous,
      );
      expect(await db.query('SELECT * FROM notifications')).toEqual(notices);
      expect((await wallet(id)).balance).toBe('120.00');
      expect(await backfill()).toEqual([{ credited: 0 }]);
    });

    it('serializes duplicate grants and parallel catch-up workers', async () => {
      const id = await historicalUser('POINTS');
      await historicalUser();
      await Promise.all([
        db.query('SELECT zwanga_try_grant_welcome_bonus($1)', [id]),
        backfill(),
        backfill(),
      ]);
      await backfill();
      expect(await db.query('SELECT * FROM welcome_bonus_grants')).toHaveLength(
        2,
      );
      expect(await db.query('SELECT * FROM notifications')).toHaveLength(2);
      expect((await wallet(id)).balance).toBe('120.00');
    });

    function auth(id: string) {
      const token = `${id}.${randomBytes(32).toString('base64url')}`;
      const hash = createHash('sha256').update(token).digest('hex');
      const values = new Map([[`auth:pin-reset:${id}`, hash]]);
      const redis = {
        get: jest.fn(async (key: string) => values.get(key) ?? null),
        consumeIfValueMatches: jest.fn(
          async (key: string, expected: string) => {
            if (values.get(key) !== expected) return false;
            values.delete(key);
            return true;
          },
        ),
      };
      const service = new AuthService(
        db.getRepository(User),
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        redis as any,
      );
      return {
        service,
        redis,
        values,
        dto: { resetToken: token, newPin: '5678' },
      };
    }

    it('saves the PIN, revokes sessions and forbids concurrent proof replay on real row locks', async () => {
      const id = await historicalUser('CDF');
      const f = auth(id);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      f.redis.consumeIfValueMatches.mockRejectedValue(
        new Error('cleanup unavailable'),
      );
      const results = await Promise.allSettled([
        f.service.resetPin(f.dto),
        f.service.resetPin({ ...f.dto, newPin: '9876' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejection = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejection.reason).toBeInstanceOf(BadRequestException);
      const [row] = await db.query('SELECT * FROM users WHERE id=$1', [id]);
      const winningPin = results[0].status === 'fulfilled' ? '5678' : '9876';
      expect(await bcrypt.compare(winningPin, row.password)).toBe(true);
      expect(row.accessToken).toBeNull();
      expect(row.refreshToken).toBeNull();
      await expect(f.service.resetPin(f.dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const publicUser = await db.getRepository(User).findOneBy({ id });
      expect(publicUser?.lastPinResetTokenHash).toBeUndefined();
      expect(JSON.parse(JSON.stringify(publicUser))).not.toHaveProperty(
        'lastPinResetTokenHash',
      );
    });

    it('rolls back PIN and replay marker together on a real deferred COMMIT failure', async () => {
      const id = await historicalUser('POINTS');
      const f = auth(id);
      await db.query(`CREATE FUNCTION test_reject_pin() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'TEST_DEFERRED_FAILURE'; END $$;
      CREATE CONSTRAINT TRIGGER test_pin_failure AFTER UPDATE ON users DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION test_reject_pin();`);
      try {
        await expect(f.service.resetPin(f.dto)).rejects.toThrow(
          'TEST_DEFERRED_FAILURE',
        );
        expect(f.redis.consumeIfValueMatches).not.toHaveBeenCalled();
        const [row] = await db.query('SELECT * FROM users WHERE id=$1', [id]);
        expect(row.password).toBe('old-hash');
        expect(row.lastPinResetTokenHash).toBeNull();
      } finally {
        await db.query(
          'DROP TRIGGER test_pin_failure ON users; DROP FUNCTION test_reject_pin()',
        );
      }
      await expect(f.service.resetPin(f.dto)).resolves.toHaveProperty(
        'message',
      );
    });
  },
);
