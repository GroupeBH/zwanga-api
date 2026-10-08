import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { DataSource } from 'typeorm';
import { DriverCashCommissions1780000050000 } from './migrations/1780000050000-DriverCashCommissions';
import { AddVerifiedWelcomeBonus1780000052000 } from './migrations/1780000052000-AddVerifiedWelcomeBonus';
import { PrioritizeDriverWelcomeBonus1780000054000 } from './migrations/1780000054000-PrioritizeDriverWelcomeBonus';
import { DriverWelcomeBonusCopy1780000059000 } from './migrations/1780000059000-DriverWelcomeBonusCopy';
import { UserRole } from '../users/entities/user.entity';
import { CashCommissionCredit1780000053000 } from './migrations/1780000053000-CashCommissionCredit';
import { walletMovementNotification } from '../notifications/financial-notification.policy';
import { cashAllTokenOriginsCases } from '../../test/cash-all-token-origins-postgres';
import { financialRolloutCases } from '../../test/financial-rollout-postgres';
import { publicationRequestUuidCases } from '../../test/publication-request-uuid-postgres';
import { WalletLedgerEntry } from '../wallet/entities/wallet-ledger-entry.entity';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// Opt-in disposable cluster only; never reads an application .env or database URL.
const pgBin = process.env.DRIVER_FINANCE_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'driver finance invariants on isolated PostgreSQL',
  () => {
    let directory: string, db: DataSource;
    const driver = randomUUID(),
      trip = randomUUID();
    const exe = (name: string) =>
      join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-driver-finance-test-'));
      execFileSync(
        exe('initdb'),
        [
          '-D',
          directory,
          '-U',
          'finance_test',
          '-A',
          'trust',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { windowsHide: true, stdio: 'pipe', timeout: 30_000 },
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
        { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
      );
      db = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'finance_test',
        database: 'postgres',
        extra: { max: 6 },
      });
      await db.initialize();
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users (id uuid PRIMARY KEY, phone text, status text DEFAULT 'active', "isActive" boolean DEFAULT true, role text DEFAULT 'driver');
      CREATE TABLE kyc_documents (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id), status text DEFAULT 'pending', "createdAt" timestamp DEFAULT now());
      CREATE TABLE trips (id uuid PRIMARY KEY, "driverId" uuid REFERENCES users(id), "tripRequestId" uuid, "isPrivate" boolean DEFAULT true, "isFree" boolean DEFAULT false, "pricePerSeat" numeric DEFAULT 0, "totalSeats" integer DEFAULT 1);
      CREATE TABLE trip_requests (id uuid PRIMARY KEY, status text DEFAULT 'pending', "paymentMode" text DEFAULT 'cash', "selectedDriverId" uuid, "selectedPricePerSeat" numeric, "numberOfSeats" integer DEFAULT 1, "tripId" uuid);
      CREATE TABLE recurring_trip_templates (id uuid PRIMARY KEY);
      CREATE TABLE bookings (id uuid PRIMARY KEY, "tripId" uuid REFERENCES trips(id), status text DEFAULT 'pending', "paymentMode" text DEFAULT 'cash', "paymentAmount" numeric(12,2), "paymentCurrency" text DEFAULT 'CDF', "pickedUp" boolean DEFAULT false, "cashReceivedAt" timestamp, "droppedOffAt" timestamp, "createdAt" timestamp DEFAULT now());
      CREATE TABLE wallet_accounts (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id), type text, balance numeric(12,2) DEFAULT 0, "withdrawableBalance" numeric(12,2) DEFAULT 0, currency text DEFAULT 'PTS', "withdrawalsBlocked" boolean DEFAULT false, "updatedAt" timestamp DEFAULT now(), UNIQUE ("userId",type), CHECK (balance >= 0 AND "withdrawableBalance" >= 0 AND "withdrawableBalance" <= balance));
      CREATE TABLE wallet_ledger_entries (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "accountId" uuid REFERENCES wallet_accounts(id), "userId" uuid, "accountType" text, type text, amount numeric(12,2), "withdrawableAmount" numeric(12,2), "balanceAfter" numeric(12,2), currency text, "relatedEntityType" text, "relatedEntityId" uuid, description text, CONSTRAINT "CHK_wallet_ledger_type" CHECK (type <> 'invalid'), CHECK (amount <> 0));
      CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "eventKey" text UNIQUE, "userId" uuid REFERENCES users(id), "fcmToken" text, title text, body text, data jsonb, "isAutomatic" boolean, status text, "errorMessage" text);
      CREATE TYPE subscriptions_status_enum AS ENUM ('active','expired','cancelled','pending','payment_failed');
      CREATE TABLE subscriptions (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid REFERENCES users(id), plan text, status subscriptions_status_enum, "startDate" timestamp, "endDate" timestamp, amount numeric, currency text, "premiumBadgeEnabled" boolean, "featuredTripsEnabled" boolean, "documentFundingEnabled" boolean, "documentFundingLimit" numeric, "documentFundingCurrency" text, "isTrial" boolean);
    `);
      const runner = db.createQueryRunner();
      try {
        await runner.startTransaction();
        await new DriverCashCommissions1780000050000().up(runner);
        await new AddVerifiedWelcomeBonus1780000052000().up(runner);
        await new CashCommissionCredit1780000053000().up(runner);
        await new PrioritizeDriverWelcomeBonus1780000054000().up(runner);
        await new DriverWelcomeBonusCopy1780000059000().up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    }, 60_000);
    beforeEach(async () => {
      await db.query(
        'TRUNCATE notifications,wallet_ledger_entries,cash_commissions,driver_pro_trial_claims,welcome_bonus_grants,kyc_documents,subscriptions,bookings,trip_requests,trips,wallet_accounts,users',
      );
      await db.query('INSERT INTO users (id,phone) VALUES ($1,$2)', [
        driver,
        '+243890000001',
      ]);
      await db.query('INSERT INTO trips (id,"driverId") VALUES ($1,$2)', [
        trip,
        driver,
      ]);
      await db.query(
        `INSERT INTO wallet_accounts ("userId",type,balance,"withdrawableBalance") VALUES ($1,'points',100,50)`,
        [driver],
      );
    });
    afterAll(async () => {
      try {
        if (db?.isInitialized) await db.destroy();
      } finally {
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-driver-finance-test-',
          )
        ) {
          if (existsSync(join(directory, 'postmaster.pid')))
            execFileSync(
              exe('pg_ctl'),
              ['-D', directory, '-m', 'fast', '-w', 'stop'],
              { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
            );
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }, 40_000);
    async function booking(amount = 10000, mode = 'cash', policy = 1) {
      const id = randomUUID();
      await db.query(
        'INSERT INTO bookings (id,"tripId","paymentAmount","paymentMode","cashCommissionPolicyVersion") VALUES ($1,$2,$3,$4,$5)',
        [id, trip, amount, mode, policy],
      );
      return id;
    }
    const status = (id: string, next: string) =>
      db.query('UPDATE bookings SET status=$2 WHERE id=$1', [id, next]);
    const account = async () =>
      (
        await db.query('SELECT * FROM wallet_accounts WHERE "userId"=$1', [
          driver,
        ])
      )[0];
    const commission = async (id: string) =>
      (
        await db.query('SELECT * FROM cash_commissions WHERE "bookingId"=$1', [
          id,
        ])
      )[0];

    // Diagnostic only: these tests document incompatibilities, not deployment
    // readiness. Opt in with the commit identified from the running ECS image.
    const deployedCommit = process.env.DEPLOYED_BACKEND_AUDIT_COMMIT;
    (deployedCommit ? describe : describe.skip)(
      'mixed-version deployment compatibility audit (known incompatibilities)',
      () => {
        function deployedModule(path: string): any {
          if (!/^[a-f0-9]{7,40}$/i.test(deployedCommit!)) {
            throw new Error('The audit requires an explicit Git commit hash');
          }
          const source = execFileSync('git', ['show', `${deployedCommit}:${path}`], {
            cwd: resolve(__dirname, '../..'),
            encoding: 'utf8',
            windowsHide: true,
          });
          const { outputText } = transpileModule(source, {
            compilerOptions: {
              module: ModuleKind.CommonJS,
              target: ScriptTarget.ES2022,
              experimentalDecorators: true,
            },
          });
          const loaded = { exports: {} };
          new Function('require', 'module', 'exports', outputText)(
            require,
            loaded,
            loaded.exports,
          );
          return loaded.exports;
        }

        function oldHttpStatus(error: unknown): number {
          const { ApiExceptionFilter } = deployedModule(
            'src/common/filters/api-exception.filter.ts',
          );
          return new ApiExceptionFilter().describeException(error).statusCode;
        }

        it('documents old cash acceptance returning HTTP 500 after the new defaults activate', async () => {
          await db.query(
            'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
            [driver],
          );
          const id = randomUUID();
          // The deployed booking entity omits the new policy column.
          const [created] = await db.query(
            'INSERT INTO bookings (id,"tripId","paymentAmount") VALUES ($1,$2,100000) RETURNING "cashCommissionPolicyVersion"',
            [id, trip],
          );
          expect(created.cashCommissionPolicyVersion).toBe(2);
          const error = await status(id, 'accepted').catch((value) => value);
          expect(error).toMatchObject({
            driverError: { code: 'P0001', message: 'CASH_COMMISSION_INSUFFICIENT' },
          });
          expect(oldHttpStatus(error)).toBe(500);
          expect(await db.query('SELECT status FROM bookings WHERE id=$1', [id]))
            .toEqual([{ status: 'pending' }]);
        });

        it('documents old wallet debits ignoring the new cash hold and returning HTTP 500', async () => {
          const id = await booking(10000, 'cash', 2);
          await status(id, 'accepted');
          const locked = await account();
          expect(locked.reservedCashCommissionBalance).toBe('5.00');
          const { applyTokenMovement } = deployedModule('src/wallet/wallet-origin.ts');
          // This formerly valid debit consumes the five tokens held for cash.
          expect(() => applyTokenMovement(locked, -100)).not.toThrow();
          const error = await db.query(
            'UPDATE wallet_accounts SET balance=$2,"withdrawableBalance"=$3 WHERE id=$1',
            [locked.id, locked.balance, locked.withdrawableBalance],
          ).catch((value) => value);
          expect(error).toMatchObject({
            driverError: { code: '23514', constraint: 'CHK_wallet_cash_reserve' },
          });
          expect(oldHttpStatus(error)).toBe(500);
          expect((await account()).balance).toBe('100.00');
        });

        it('documents old trip publication implicitly enabling cash and failing the new guard', async () => {
          await db.query(
            'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0 WHERE "userId"=$1',
            [driver],
          );
          // Old clients cannot opt out of cash: they do not send acceptedPaymentModes.
          const error = await db.query(
            'INSERT INTO trips (id,"driverId","isPrivate","pricePerSeat","totalSeats") VALUES ($1,$2,false,30000,2)',
            [randomUUID(), driver],
          ).catch((value) => value);
          expect(error).toMatchObject({
            driverError: { code: 'P0001', message: 'CASH_COMMISSION_INSUFFICIENT' },
          });
          expect(oldHttpStatus(error)).toBe(500);
        });
      },
    );

    describe('verified welcome bonus', () => {
      const kyc = (
        state = 'approved',
        user = driver,
        createdAt = '2026-01-01',
      ) =>
        db.query(
          'INSERT INTO kyc_documents ("userId",status,"createdAt") VALUES ($1,$2,$3) RETURNING id',
          [user, state, createdAt],
        );
      const backfill = (size = 100) =>
        db.query('SELECT zwanga_backfill_welcome_bonus($1) AS credited', [
          size,
        ]);
      const claims = () => db.query('SELECT * FROM welcome_bonus_grants');
      const welcomeLedger = () =>
        db.query<WalletLedgerEntry[]>(
          `SELECT * FROM wallet_ledger_entries WHERE "relatedEntityType"='welcome_bonus'`,
        );

      it('credits exactly 50 promotional tokens and enqueues one compatible notification', async () => {
        const [document] = await kyc();
        expect(await account()).toMatchObject({
          balance: '150.00',
          withdrawableBalance: '50.00',
          reservedCashCommissionBalance: '0.00',
        });
        const [entry] = await welcomeLedger();
        expect(entry).toMatchObject({
          amount: '50.00',
          withdrawableAmount: '0.00',
          currency: 'PTS',
          type: 'loyalty_reward',
          relatedEntityId: driver,
        });
        expect(await claims()).toMatchObject([
          {
            userId: driver,
            kycDocumentId: document.id,
            ledgerEntryId: entry.id,
          },
        ]);
        const [notice] = await db.query('SELECT * FROM notifications');
        expect(notice).toMatchObject({
          ...walletMovementNotification({
            ...entry,
            paymentTransactionId: null,
          }, UserRole.DRIVER),
          status: 'pending',
          fcmToken: '',
          isAutomatic: false,
        });
      });

      it('requires account validation in addition to KYC approval', async () => {
        await db.query(`UPDATE users SET status='pending_kyc' WHERE id=$1`, [
          driver,
        ]);
        await kyc();
        expect(await claims()).toHaveLength(0);
        await db.query(`UPDATE users SET status='active' WHERE id=$1`, [
          driver,
        ]);
        expect((await account()).balance).toBe('150.00');
      });

      it('changes future copy only without rewriting existing notifications or duplicating a welcome grant', async () => {
        await db.transaction(async manager => {
          const migration = new DriverWelcomeBonusCopy1780000059000();
          const runner = manager.queryRunner!;
          await migration.down(runner);
          await manager.query('INSERT INTO kyc_documents ("userId",status) VALUES ($1,$2)', [driver, 'approved']);
          await manager.query('SET CONSTRAINTS ALL IMMEDIATE');
          const notices = await manager.query('SELECT * FROM notifications');
          expect(notices[0].body).toContain('50 jetons de bienvenue');
          const ledger = await manager.query('SELECT * FROM wallet_ledger_entries');
          await migration.up(runner);
          await migration.up(runner);
          expect(await manager.query('SELECT * FROM notifications')).toEqual(notices);
          expect(await manager.query('SELECT * FROM wallet_ledger_entries')).toEqual(ledger);
          expect(await manager.query('SELECT zwanga_grant_welcome_bonus($1) AS credited', [driver])).toEqual([{ credited: false }]);
          expect(await manager.query('SELECT * FROM notifications')).toHaveLength(1);
        });
        expect((await account()).balance).toBe('150.00');
        expect(await claims()).toHaveLength(1);
      });

      it.each(['pending', 'rejected'])(
        'does not reward a %s KYC',
        async (state) => {
          await kyc(state);
          await backfill();
          expect(await claims()).toHaveLength(0);
          expect((await account()).balance).toBe('100.00');
        },
      );

      it.each(['suspended', 'inactive', 'pending_kyc'])(
        'excludes %s accounts from triggers and catch-up',
        async (state) => {
          await db.query('UPDATE users SET status=$2 WHERE id=$1', [
            driver,
            state,
          ]);
          await kyc();
          expect(await backfill()).toEqual([{ credited: 0 }]);
          expect(await claims()).toHaveLength(0);
        },
      );

      it('excludes disabled accounts even when their status remains active', async () => {
        await db.query('UPDATE users SET "isActive"=false WHERE id=$1', [
          driver,
        ]);
        await kyc();
        expect(await backfill()).toEqual([{ credited: 0 }]);
        await db.query('UPDATE users SET "isActive"=true WHERE id=$1', [
          driver,
        ]);
        expect(await claims()).toHaveLength(1);
      });

      it.each(['admin', 'super_admin'])(
        'excludes internal role %s',
        async (role) => {
          await db.query('UPDATE users SET role=$2 WHERE id=$1', [
            driver,
            role,
          ]);
          await kyc();
          expect(await backfill()).toEqual([{ credited: 0 }]);
          expect(await claims()).toHaveLength(0);
        },
      );

      it('also creates a passenger wallet with no purchased-token allowance', async () => {
        const passenger = randomUUID();
        await db.query(`INSERT INTO users(id,role) VALUES ($1,'passenger')`, [
          passenger,
        ]);
        await kyc('approved', passenger);
        const [wallet] = await db.query(
          'SELECT * FROM wallet_accounts WHERE "userId"=$1',
          [passenger],
        );
        expect(wallet).toMatchObject({
          balance: '50.00',
          withdrawableBalance: '0.00',
          currency: 'PTS',
        });
        const [notice] = await db.query('SELECT body FROM notifications WHERE "userId"=$1', [passenger]);
        expect(notice.body).toContain('50 jetons de bienvenue');
        expect(notice.body).not.toContain('abonnement Pro');
      });

      it('uses the latest KYC, not any historical approval (including timestamp ties)', async () => {
        await db.transaction(async (m) => {
          await m.query(
            `INSERT INTO kyc_documents (id,"userId",status) VALUES
            ('00000000-0000-4000-8000-000000000001',$1,'approved'),
            ('00000000-0000-4000-8000-000000000002',$1,'pending')`,
            [driver],
          );
        });
        expect(await backfill()).toEqual([{ credited: 0 }]);
        await db.query(
          `UPDATE kyc_documents SET status='approved' WHERE id='00000000-0000-4000-8000-000000000002'`,
        );
        expect(await claims()).toHaveLength(1);
      });

      it('observes the final transaction state, not an intermediate approval', async () => {
        await db.transaction(async (m) => {
          await m.query(
            `INSERT INTO kyc_documents ("userId",status) VALUES ($1,'approved')`,
            [driver],
          );
          await m.query(`UPDATE users SET status='suspended' WHERE id=$1`, [
            driver,
          ]);
        });
        expect(await claims()).toHaveLength(0);
        expect(await db.query('SELECT * FROM notifications')).toHaveLength(0);
      });

      it('rolls back credits, claims and push together and hides them before commit', async () => {
        await expect(
          db.transaction(async (m) => {
            await m.query(
              `INSERT INTO kyc_documents ("userId",status) VALUES ($1,'approved')`,
              [driver],
            );
            await m.query('SET CONSTRAINTS ALL IMMEDIATE');
            expect(
              await m.query('SELECT * FROM welcome_bonus_grants'),
            ).toHaveLength(1);
            expect(await db.query('SELECT * FROM notifications')).toHaveLength(
              0,
            );
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
        expect((await account()).balance).toBe('100.00');
        expect(await claims()).toHaveLength(0);
        expect(await welcomeLedger()).toHaveLength(0);
      });

      it('does not reaward after retries, suspension/reactivation or revalidation', async () => {
        await kyc();
        await Promise.all(
          Array.from({ length: 5 }, () =>
            db.query('SELECT zwanga_grant_welcome_bonus($1)', [driver]),
          ),
        );
        await db.query(`UPDATE users SET status='suspended' WHERE id=$1`, [
          driver,
        ]);
        await db.query(`UPDATE users SET status='active' WHERE id=$1`, [
          driver,
        ]);
        await kyc('approved', driver, '2026-02-01');
        expect(await claims()).toHaveLength(1);
        expect(await welcomeLedger()).toHaveLength(1);
        expect((await account()).balance).toBe('150.00');
      });

      it('preserves purchased balances, cash holds and outstanding commission debts', async () => {
        const id = await booking();
        await status(id, 'accepted');
        await kyc();
        expect(await account()).toMatchObject({
          balance: '150.00',
          withdrawableBalance: '50.00',
          reservedCashCommissionBalance: '5.00',
        });
        await db.query(
          `UPDATE bookings SET "paymentAmount"=200000,status='completed',"pickedUp"=true WHERE id=$1`,
          [id],
        );
        expect((await commission(id)).debtTokens).toBe('50.00');
        expect((await account()).balance).toBe('100.00');
        expect((await account()).withdrawableBalance).toBe('0.00');
      });

      it('does not use a welcome credit to settle an existing cash commission debt', async () => {
        const id = await booking();
        await status(id, 'accepted');
        await db.query(
          `UPDATE bookings SET "paymentAmount"=200000,status='completed',"pickedUp"=true WHERE id=$1`,
          [id],
        );
        expect((await commission(id)).debtTokens).toBe('50.00');
        await kyc();
        expect((await commission(id)).debtTokens).toBe('50.00');
        expect(await account()).toMatchObject({
          balance: '100.00',
          withdrawableBalance: '0.00',
        });
      });

      it('defers a contended wallet credit without blocking KYC approval or losing the bonus', async () => {
        const writer = db.createQueryRunner();
        await writer.startTransaction();
        try {
          await writer.query(
            'SELECT id FROM wallet_accounts WHERE "userId"=$1 FOR UPDATE',
            [driver],
          );
          // Existing KYC handlers already lock users FOR UPDATE before approval.
          await db.transaction(async (m) => {
            await m.query("SET LOCAL statement_timeout = '3s'");
            await m.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
              driver,
            ]);
            await m.query(
              `INSERT INTO kyc_documents ("userId",status) VALUES ($1,'approved')`,
              [driver],
            );
            await m.query('SET CONSTRAINTS ALL IMMEDIATE');
            expect(await m.query('SHOW lock_timeout')).toEqual([
              { lock_timeout: '0' },
            ]);
          });
          expect(await claims()).toHaveLength(0);
          await writer.commitTransaction();
        } finally {
          if (writer.isTransactionActive) await writer.rollbackTransaction();
          await writer.release();
        }
        expect(await backfill()).toEqual([{ credited: 1 }]);
        expect((await account()).balance).toBe('150.00');
      });

      async function historicalEligible(count: number) {
        // Simulates rows that existed before trigger installation, in this isolated cluster only.
        await db.transaction(async (m) => {
          await m.query(
            'ALTER TABLE kyc_documents DISABLE TRIGGER kyc_verified_welcome_bonus',
          );
          try {
            for (let i = 0; i < count; i++) {
              const id = randomUUID();
              await m.query(
                `INSERT INTO users (id,status) VALUES ($1,'pending_kyc')`,
                [id],
              );
              await m.query(
                'ALTER TABLE users DISABLE TRIGGER users_verified_welcome_bonus',
              );
              await m.query(`UPDATE users SET status='active' WHERE id=$1`, [
                id,
              ]);
              await m.query(
                'ALTER TABLE users ENABLE TRIGGER users_verified_welcome_bonus',
              );
              await m.query(
                `INSERT INTO kyc_documents ("userId",status) VALUES ($1,'approved')`,
                [id],
              );
            }
          } finally {
            await m.query(
              'ALTER TABLE kyc_documents ENABLE TRIGGER kyc_verified_welcome_bonus',
            );
          }
        });
      }

      it('catches up existing users in bounded restartable batches with no duplicate push', async () => {
        await historicalEligible(3);
        expect(await claims()).toHaveLength(0);
        expect(await backfill(2)).toEqual([{ credited: 2 }]);
        expect(await backfill(2)).toEqual([{ credited: 1 }]);
        expect(await backfill(2)).toEqual([{ credited: 0 }]);
        expect(await welcomeLedger()).toHaveLength(3);
        expect(await db.query('SELECT * FROM notifications')).toHaveLength(3);
      });

      it('prioritizes existing drivers over passengers without reawarding the original bonus', async () => {
        await historicalEligible(3);
        const rows = await db.query('SELECT "userId" FROM kyc_documents ORDER BY "userId"');
        // The passenger has the smallest UUID, so a plain ID order would credit them first.
        await db.transaction(async (m) => {
          await m.query('ALTER TABLE users DISABLE TRIGGER users_verified_welcome_bonus');
          await m.query(`UPDATE users SET role='passenger' WHERE id=$1`, [rows[0].userId]);
          await m.query('ALTER TABLE users ENABLE TRIGGER users_verified_welcome_bonus');
        });
        expect(await backfill(1)).toEqual([{ credited: 1 }]);
        expect((await claims())[0].userId).toBe(rows[1].userId);
        expect(await backfill(1)).toEqual([{ credited: 1 }]);
        expect(await claims()).toHaveLength(2);
        expect(await backfill(1)).toEqual([{ credited: 1 }]);
        expect(await backfill(1)).toEqual([{ credited: 0 }]);
        expect(await welcomeLedger()).toHaveLength(3);
        expect(await db.query('SELECT * FROM notifications')).toHaveLength(3);
      });

      it('skips a busy driver and catches them up on the next cron without duplicate credits', async () => {
        await historicalEligible(2);
        const [busy] = await db.query('SELECT "userId" FROM kyc_documents ORDER BY "userId" LIMIT 1');
        const lock = db.createQueryRunner();
        await lock.startTransaction();
        try {
          await lock.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [busy.userId]);
          expect(await backfill(2)).toEqual([{ credited: 1 }]);
          expect((await claims())[0].userId).not.toBe(busy.userId);
        } finally {
          await lock.rollbackTransaction();
          await lock.release();
        }
        expect(await backfill(2)).toEqual([{ credited: 1 }]);
        expect(await backfill(2)).toEqual([{ credited: 0 }]);
        expect(await claims()).toHaveLength(2);
      });

      it('serializes concurrent first-time grants and supports parallel ECS catch-up workers', async () => {
        await historicalEligible(5);
        const [target] = await db.query(
          'SELECT "userId" FROM kyc_documents LIMIT 1',
        );
        await Promise.all([
          db.query('SELECT zwanga_grant_welcome_bonus($1)', [target.userId]),
          db.query('SELECT zwanga_grant_welcome_bonus($1)', [target.userId]),
          backfill(2),
          backfill(2),
        ]);
        await backfill();
        expect(await claims()).toHaveLength(5);
        expect(await welcomeLedger()).toHaveLength(5);
        expect(await db.query('SELECT * FROM notifications')).toHaveLength(5);
      });

      it('retains the claim if wallet ledger history is removed', async () => {
        await kyc();
        await db.query('DELETE FROM wallet_ledger_entries');
        await db.query('SELECT zwanga_grant_welcome_bonus($1)', [driver]);
        expect((await account()).balance).toBe('150.00');
        expect(await welcomeLedger()).toHaveLength(0);
      });

      it.each([0, 101, null])(
        'rejects an unbounded/invalid catch-up size %s',
        async (size) => {
          await expect(
            db.query('SELECT zwanga_backfill_welcome_bonus($1)', [size]),
          ).rejects.toThrow('WELCOME_BONUS_INVALID_BATCH_SIZE');
        },
      );
    });

    describe('5% commission with 25-token credit', () => {
      const emptyReserve = () => db.query('UPDATE wallet_accounts SET "withdrawableBalance"=0');
      const credit = (amount: number, purchased = true) => db.transaction(async (manager) => {
        const [a] = await manager.query('UPDATE wallet_accounts SET balance=balance+$1,"withdrawableBalance"="withdrawableBalance"+$2 RETURNING *', [amount, purchased ? amount : 0]);
        await manager.query(`INSERT INTO wallet_ledger_entries ("accountId","userId",type,amount,"withdrawableAmount","balanceAfter") VALUES ($1,$2,'top_up',$3,$4,$5)`, [a.id, driver, amount, purchased ? amount : 0, a.balance]);
      });
      const request = async (price = 25000, seats = 2) => {
        const id = randomUUID();
        await db.query(`INSERT INTO trip_requests (id,"selectedPricePerSeat","numberOfSeats") VALUES ($1,$2,$3)`, [id, price, seats]);
        return id;
      };
      const selectDriver = (id: string) => db.query(`UPDATE trip_requests SET status='driver_selected',"selectedDriverId"=$2 WHERE id=$1`, [id, driver]);

      it('permits exactly 25 tokens, rejects any new cash, and reports the due', async () => {
        await emptyReserve();
        const id = await booking(50000, 'cash', 2);
        await status(id, 'accepted');
        expect(await commission(id)).toMatchObject({ commissionRate: '0.050', tokensDue: '25.00', debtTokens: '25.00', reservedTokens: '0.00' });
        const other = await booking(1, 'cash', 2);
        await expect(status(other, 'accepted')).rejects.toThrow('CASH_DEBT_OUTSTANDING');
        expect(await db.query(`SELECT data->>'debtTokens' AS due FROM notifications WHERE data->>'type'='cash_commission_debt'`)).toEqual([{ due: '25.00' }]);
        await status(id, 'accepted'); // Retry does not reserve or notify twice.
        expect(await db.query('SELECT * FROM notifications')).toHaveLength(1);
      });
      it('refuses one hundredth above the cap without any side effect', async () => {
        await emptyReserve();
        const id = await booking(50020, 'cash', 2);
        await expect(status(id, 'accepted')).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
        expect(await commission(id)).toBeUndefined();
        expect(await db.query('SELECT * FROM notifications')).toHaveLength(0);
      });
      it('serializes competing acceptances and counts existing holds', async () => {
        const ids = await Promise.all([booking(140000, 'cash', 2), booking(140000, 'cash', 2)]);
        const results = await Promise.allSettled(ids.map(id => status(id, 'accepted')));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect((await account()).reservedCashCommissionBalance).toBe('50.00');
        expect(await db.query('SELECT "debtTokens" FROM cash_commissions')).toEqual([{ debtTokens: '20.00' }]);
      });
      it('checks all publication seats but does not debit or reserve at publication', async () => {
        await emptyReserve();
        const publish = (seats: number) => db.query(`INSERT INTO trips (id,"driverId","isPrivate","pricePerSeat","totalSeats") VALUES ($1,$2,false,10000,$3)`, [randomUUID(), driver, seats]);
        await publish(5);
        await expect(publish(6)).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
        expect(await db.query('SELECT * FROM cash_commissions')).toHaveLength(0);
        const id = await booking(10000, 'cash', 2); await status(id, 'accepted');
        await expect(publish(1)).rejects.toThrow('CASH_DEBT_OUTSTANDING');
        await db.query(`INSERT INTO trips (id,"driverId","isPrivate","pricePerSeat","totalSeats","acceptedPaymentModes") VALUES ($1,$2,false,10000,10,ARRAY['points'])`, [randomUUID(), driver]);
      });
      it('settles a reserved debt on recharge, ignores bonus, and unblocks only once paid', async () => {
        await emptyReserve();
        const id = await booking(50000, 'cash', 2); await status(id, 'accepted');
        await credit(100, false);
        expect((await commission(id)).debtTokens).toBe('25.00');
        await credit(10);
        expect(await commission(id)).toMatchObject({ debtTokens: '15.00', reservedTokens: '10.00' });
        const other = await booking(10000, 'cash', 2);
        await expect(status(other, 'accepted')).rejects.toThrow('CASH_DEBT_OUTSTANDING');
        await credit(15);
        expect(await commission(id)).toMatchObject({ debtTokens: '0.00', reservedTokens: '25.00' });
        await status(id, 'completed');
        await status(other, 'accepted');
        expect((await commission(other)).debtTokens).toBe('5.00');
      });
      it('clears the debt and refunds holds when a confirmed ride is cancelled', async () => {
        const id = await booking(140000, 'cash', 2); await status(id, 'accepted');
        await status(id, 'cancelled');
        expect(await commission(id)).toMatchObject({ debtTokens: '0.00', reservedTokens: '0.00', tokensDue: '0.00' });
        expect((await account()).withdrawableBalance).toBe('50.00');
      });
      it('allows a boarded fare adjustment above 25, but rejects it before boarding', async () => {
        await emptyReserve();
        const id = await booking(10000, 'cash', 2); await status(id, 'accepted');
        await expect(db.query('UPDATE bookings SET "paymentAmount"=100000 WHERE id=$1', [id])).rejects.toThrow();
        await db.query(`UPDATE bookings SET "pickedUp"=true,"paymentAmount"=100000,status='completed' WHERE id=$1`, [id]);
        expect(await commission(id)).toMatchObject({ debtTokens: '50.00', chargedTokens: '0.00' });
        await credit(50);
        expect(await commission(id)).toMatchObject({ debtTokens: '0.00', chargedTokens: '50.00' });
        await status(id, 'completed');
        expect((await account()).withdrawableBalance).toBe('0.00');
      });
      it('holds dispatch funds immediately and transfers the same debt to the actual booking', async () => {
        await emptyReserve();
        const rid = await request(); await selectDriver(rid);
        expect(await commission(rid)).toMatchObject({ requestId: rid, debtTokens: '25.00' });
        const other = await request(1000, 1);
        await expect(selectDriver(other)).rejects.toThrow('CASH_DEBT_OUTSTANDING');
        await db.query('UPDATE trips SET "tripRequestId"=$1 WHERE id=$2', [rid, trip]);
        const bid = await booking(50000, 'cash', 2);
        await status(bid, 'accepted');
        await db.query('UPDATE trip_requests SET "tripId"=$2 WHERE id=$1', [rid, trip]);
        expect(await commission(rid)).toBeUndefined();
        expect(await commission(bid)).toMatchObject({ requestId: rid, debtTokens: '25.00', tripId: trip });
        expect(await db.query('SELECT * FROM cash_commissions')).toHaveLength(1);
        await status(bid, 'completed');
      });
      it('releases a dispatch debt when the unstarted request is cancelled', async () => {
        const rid = await request(140000, 1); await selectDriver(rid);
        await db.query(`UPDATE trip_requests SET status='cancelled' WHERE id=$1`, [rid]);
        expect(await commission(rid)).toMatchObject({ debtTokens: '0.00', reservedTokens: '0.00' });
        expect((await account()).reservedCashCommissionBalance).toBe('0.00');
      });
      it('allows replacement of an overdue driver without reusing their debt or blocking the new owner', async () => {
        const rid = await request(140000, 1); await selectDriver(rid);
        await db.query(`UPDATE trip_requests SET status='pending',"selectedDriverId"=NULL WHERE id=$1`, [rid]);
        const replacement = randomUUID();
        await db.query('INSERT INTO users (id) VALUES ($1)', [replacement]);
        await db.query(`UPDATE trip_requests SET "selectedPricePerSeat"=10000,status='driver_selected',"selectedDriverId"=$2 WHERE id=$1`, [rid, replacement]);
        expect(await commission(rid)).toMatchObject({ driverId: replacement, debtTokens: '5.00' });
        expect(await db.query('SELECT state,"debtTokens" FROM cash_commissions WHERE "driverId"=$1', [driver])).toEqual([{ state: 'released', debtTokens: '0.00' }]);
      });
      it('rejects an unaffordable direct-request private trip before it is inserted', async () => {
        await emptyReserve();
        const rid = await request(30000, 2);
        await expect(db.query(`INSERT INTO trips (id,"driverId","tripRequestId","pricePerSeat","totalSeats") VALUES ($1,$2,$3,30000,2)`, [randomUUID(), driver, rid])).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
        expect(await db.query('SELECT id FROM trips')).toHaveLength(1);
      });
    });

    it('reserves purchased tokens, captures once, and starts one 30-day Pro trial', async () => {
      const id = await booking();
      await status(id, 'accepted');
      expect(await account()).toMatchObject({
        balance: '100.00',
        withdrawableBalance: '50.00',
        reservedCashCommissionBalance: '5.00',
      });
      await status(id, 'completed');
      await status(id, 'completed');
      expect(await account()).toMatchObject({
        balance: '95.00',
        withdrawableBalance: '45.00',
        reservedCashCommissionBalance: '0.00',
      });
      expect(await commission(id)).toMatchObject({
        state: 'captured',
        chargedTokens: '5.00',
        debtTokens: '0.00',
      });
      expect(await db.query('SELECT type FROM wallet_ledger_entries')).toEqual([
        { type: 'cash_commission' },
      ]);
      const [s] = await db.query(
        `SELECT amount, "isTrial", EXTRACT(EPOCH FROM ("endDate" - "startDate"))/86400 AS days FROM subscriptions`,
      );
      expect(Number(s.days)).toBe(30);
      expect(Number(s.amount)).toBe(0);
      expect(s.isTrial).toBe(true);
      expect(
        await db.query('SELECT * FROM driver_pro_trial_claims'),
      ).toHaveLength(1);
    });
    it('rejects rewards-only and insufficient reserves without mutating the booking', async () => {
      await db.query('UPDATE wallet_accounts SET "withdrawableBalance"=0');
      const id = await booking();
      await expect(status(id, 'accepted')).rejects.toThrow(
        'CASH_COMMISSION_INSUFFICIENT',
      );
      expect(
        (await db.query('SELECT status FROM bookings WHERE id=$1', [id]))[0]
          .status,
      ).toBe('pending');
      expect(await commission(id)).toBeUndefined();
    });
    it('serializes simultaneous reservations against the same purchased balance', async () => {
      const ids = await Promise.all([booking(60000), booking(60000)]);
      const results = await Promise.allSettled(
        ids.map((id) => status(id, 'accepted')),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await account()).reservedCashCommissionBalance).toBe('30.00');
    });
    it('waits for the user lock before taking the wallet, preventing a cash/admin lock inversion', async () => {
      const id = await booking();
      const admin = db.createQueryRunner(),
        cash = db.createQueryRunner();
      await admin.connect();
      await cash.connect();
      await admin.startTransaction();
      await admin.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
        driver,
      ]);
      const [{ pid }] = await cash.query('SELECT pg_backend_pid() AS pid');
      const accepting = cash.query(
        `UPDATE bookings SET status='accepted' WHERE id=$1`,
        [id],
      );
      // Handle any rejection immediately while the competing transaction is active.
      const result = accepting.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await db.query(
            'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
            [pid],
          );
          if (row.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await expect(
          admin.query(
            'SELECT id FROM wallet_accounts WHERE "userId"=$1 FOR UPDATE NOWAIT',
            [driver],
          ),
        ).resolves.toHaveLength(1);
        await admin.commitTransaction();
        expect(await result).toBeNull();
        expect((await account()).reservedCashCommissionBalance).toBe('5.00');
      } finally {
        if (admin.isTransactionActive) await admin.rollbackTransaction();
        await result;
        await cash.release();
        await admin.release();
      }
    });
    it('protects held tokens even from a raw wallet debit and releases on cancellation/delete', async () => {
      const id = await booking();
      await status(id, 'accepted');
      await expect(
        db.query('UPDATE wallet_accounts SET "withdrawableBalance"=0'),
      ).rejects.toThrow();
      await status(id, 'cancelled');
      expect((await account()).reservedCashCommissionBalance).toBe('0.00');
      const other = await booking();
      await status(other, 'accepted');
      await db.query('DELETE FROM bookings WHERE id=$1', [other]);
      expect((await account()).balance).toBe('100.00');
      expect((await account()).reservedCashCommissionBalance).toBe('0.00');
    });
    it.each(['electronic', 'points'])(
      'does not debit or reserve driver tokens for %s',
      async (mode) => {
        const id = await booking(10000, mode);
        await status(id, 'accepted');
        await status(id, 'completed');
        expect((await account()).balance).toBe('100.00');
        expect(await commission(id)).toBeUndefined();
      },
    );
    it('enforces trip modes even when the client omits its mode and receives the cash default', async () => {
      await db.query(`UPDATE trips SET "acceptedPaymentModes"=ARRAY['points']`);
      await expect(booking()).rejects.toThrow('TRIP_PAYMENT_MODE_UNAVAILABLE');
      await expect(booking(10000, 'points')).resolves.toBeTruthy();
    });
    it('releases/refunds cash commission when switching to an electronic payment before cash receipt', async () => {
      const id = await booking();
      await status(id, 'accepted');
      await status(id, 'completed');
      await db.query(
        `UPDATE bookings SET "paymentMode"='electronic' WHERE id=$1`,
        [id],
      );
      expect((await account()).balance).toBe('100.00');
      expect((await commission(id)).state).toBe('released');
      expect(
        await db.query('SELECT type FROM wallet_ledger_entries ORDER BY type'),
      ).toEqual([
        { type: 'cash_commission' },
        { type: 'cash_commission_refund' },
      ]);
    });
    it('finishes an ongoing ride with an uncovered fare adjustment, then settles debt once after a purchased credit', async () => {
      await db.query(
        'UPDATE wallet_accounts SET balance=5,"withdrawableBalance"=5',
      );
      const id = await booking();
      await status(id, 'accepted');
      await db.query(
        `UPDATE bookings SET "pickedUp"=true,"paymentAmount"=20000,status='completed' WHERE id=$1`,
        [id],
      );
      expect(await commission(id)).toMatchObject({
        chargedTokens: '5.00',
        debtTokens: '5.00',
      });
      const other = await booking();
      await expect(status(other, 'accepted')).rejects.toThrow('CASH_DEBT_OUTSTANDING');
      await db.transaction(async (manager) => {
        const [a] = await manager.query(
          'UPDATE wallet_accounts SET balance=balance+10,"withdrawableBalance"="withdrawableBalance"+10 RETURNING *',
        );
        await manager.query(
          `INSERT INTO wallet_ledger_entries ("accountId","userId",type,amount,"withdrawableAmount","balanceAfter") VALUES ($1,$2,'top_up',10,10,10)`,
          [a.id, driver],
        );
      });
      expect(await commission(id)).toMatchObject({
        chargedTokens: '10.00',
        debtTokens: '0.00',
      });
      expect((await account()).balance).toBe('5.00');
      await status(id, 'completed');
      expect((await account()).balance).toBe('5.00');
    });
    it('does not charge grandfathered accepted bookings retroactively', async () => {
      const id = await booking();
      await db.query(
        'UPDATE bookings SET "cashCommissionPolicyVersion"=0 WHERE id=$1',
        [id],
      );
      await status(id, 'accepted');
      await status(id, 'completed');
      expect((await account()).balance).toBe('100.00');
    });
    it.each(['no_show', 'boarding_uncertain'])(
      'releases the hold without charging a ride that did not happen (%s)',
      async (next) => {
        const id = await booking();
        await status(id, 'accepted');
        await status(id, next);
        expect((await account()).reservedCashCommissionBalance).toBe('0.00');
        expect((await account()).balance).toBe('100.00');
        expect((await commission(id)).state).toBe('released');
      },
    );
    it('does not allow choosing unfunded cash at the end of an electronic ride', async () => {
      const id = await booking(10000, 'electronic');
      await status(id, 'accepted');
      await status(id, 'completed');
      await db.query('UPDATE wallet_accounts SET "withdrawableBalance"=0');
      await expect(
        db.query(`UPDATE bookings SET "paymentMode"='cash' WHERE id=$1`, [id]),
      ).rejects.toThrow('CASH_COMMISSION_INSUFFICIENT');
      expect(await commission(id)).toBeUndefined();
    });
    it('allows GPS to recover a real ride after a false no-show without losing the debt', async () => {
      const id = await booking();
      await status(id, 'accepted');
      await status(id, 'no_show');
      await db.query(
        'UPDATE wallet_accounts SET balance=0,"withdrawableBalance"=0',
      );
      await db.query(
        `UPDATE bookings SET status='completed',"pickedUp"=true WHERE id=$1`,
        [id],
      );
      expect(await commission(id)).toMatchObject({
        state: 'captured',
        chargedTokens: '0.00',
        debtTokens: '5.00',
      });
    });
    it('does not change the mode after cash receipt', async () => {
      const id = await booking();
      await status(id, 'accepted');
      await status(id, 'completed');
      await db.query('UPDATE bookings SET "cashReceivedAt"=now() WHERE id=$1', [
        id,
      ]);
      await expect(
        db.query(`UPDATE bookings SET "paymentMode"='points' WHERE id=$1`, [
          id,
        ]),
      ).rejects.toThrow('CASH_STATE_CONFLICT');
      expect((await account()).balance).toBe('95.00');
    });
    it('does not debit twice after a fare decrease, retries, or a conversion change', async () => {
      const id = await booking();
      await status(id, 'accepted');
      await status(id, 'completed');
      await db.query(
        'UPDATE bookings SET "paymentAmount"=5000,"cashCommissionTokenValue"=200 WHERE id=$1',
        [id],
      );
      await status(id, 'completed');
      expect(await commission(id)).toMatchObject({
        chargedTokens: '2.50',
        moneyPerToken: '100.0000',
      });
      expect((await account()).balance).toBe('97.50');
      expect(
        await db.query('SELECT * FROM wallet_ledger_entries'),
      ).toHaveLength(2);
      expect(
        await db.query(
          `SELECT * FROM notifications WHERE data->>'ledgerEntryId' IS NOT NULL`,
        ),
      ).toHaveLength(2);
    });
    it('preserves the trial clock on retries, subsequent rides and same-number re-registration', async () => {
      const id = await booking();
      await status(id, 'accepted');
      await status(id, 'completed');
      const [original] = await db.query(
        'SELECT * FROM driver_pro_trial_claims',
      );
      const other = await booking();
      await status(other, 'accepted');
      await status(other, 'completed');
      await db.query('SELECT zwanga_start_driver_trial($1, now())', [driver]);
      expect(await db.query('SELECT * FROM driver_pro_trial_claims')).toEqual([
        original,
      ]);
      const recreated = randomUUID();
      await db.query('INSERT INTO users (id,phone) VALUES ($1,$2)', [
        recreated,
        '+243 89 000 0001',
      ]);
      const [claim] = await db.query(
        'SELECT zwanga_start_driver_trial($1,now()) AS id',
        [recreated],
      );
      expect(claim.id).toBeNull();
      expect(await db.query('SELECT * FROM subscriptions')).toHaveLength(1);
    });
    it('does not turn an old first ride into a fresh trial', async () => {
      const [row] = await db.query(
        `SELECT zwanga_start_driver_trial($1,now() - interval '45 days') AS id`,
        [driver],
      );
      const [subscription] = await db.query(
        'SELECT status FROM subscriptions WHERE id=$1',
        [row.id],
      );
      expect(subscription.status).toBe('expired');
      expect(
        await db.query(
          `SELECT * FROM notifications WHERE data->>'type'='driver_pro_trial_started'`,
        ),
      ).toHaveLength(0);
    });
    it('rolls back both the reservation and wallet hold if the business transaction fails', async () => {
      const id = await booking();
      await expect(
        db.transaction(async (m) => {
          await m.query(`UPDATE bookings SET status='accepted' WHERE id=$1`, [
            id,
          ]);
          throw new Error('business failure');
        }),
      ).rejects.toThrow('business failure');
      expect((await account()).reservedCashCommissionBalance).toBe('0.00');
      expect(await commission(id)).toBeUndefined();
    });
    cashAllTokenOriginsCases(() => db, driver, trip);
    financialRolloutCases(() => db, driver, trip);
    publicationRequestUuidCases(() => db, driver);
  },
);
