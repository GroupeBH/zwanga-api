import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { DataSource } from 'typeorm';
import { postgresTestServerOptions } from '../../test/postgres-test-options';
import { TokenValue25Cdf1780000070000 } from './migrations/1780000070000-TokenValue25Cdf';
import { WelcomeBonus25CdfCopy1780000071000 } from './migrations/1780000071000-WelcomeBonus25CdfCopy';
import { TokenValue10Cdf1780000080000 } from './migrations/1780000080000-TokenValue10Cdf';

// Only a throwaway cluster on a random loopback port. No application env/DB URL.
const bin = process.env.TOKEN_VALUE_TEST_POSTGRES_BIN ?? process.env.WALLET_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'token value migration on isolated PostgreSQL',
  () => {
    let directory: string, db: DataSource;
    const exe = (name: string) =>
      join(bin!, process.platform === 'win32' ? `${name}.exe` : name);

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-token-value-test-'));
      execFileSync(
        exe('initdb'),
        [
          '-D',
          directory,
          '-U',
          'token_value_test',
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
        username: 'token_value_test',
        database: 'postgres',
      });
      await db.initialize();
      await db.query(`CREATE TABLE bookings (id integer PRIMARY KEY, "cashCommissionTokenValue" numeric(12,4) NOT NULL DEFAULT 100);
      CREATE TABLE payment_transactions (id integer PRIMARY KEY, purpose text NOT NULL, amount numeric(12,2) NOT NULL);
      CREATE TABLE wallet_accounts (id integer PRIMARY KEY, balance numeric(12,2));
      INSERT INTO bookings(id) VALUES (1);
      INSERT INTO payment_transactions VALUES (1, 'wallet_top_up', 5000);
      INSERT INTO wallet_accounts VALUES (1, 100);`);
      await db.transaction((manager) =>
        new TokenValue25Cdf1780000070000().up(manager.queryRunner!),
      );
    }, 60000);

    afterAll(async () => {
      try {
        if (db?.isInitialized) await db.destroy();
      } finally {
        if (
          directory &&
          resolve(directory).startsWith(
            resolve(tmpdir()) + sep + 'zwanga-token-value-test-',
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

    it('keeps existing balances and quotes unchanged and quotes new bookings at 25', async () => {
      await db.query('INSERT INTO bookings(id) VALUES (2)');
      expect(
        await db.query(
          'SELECT "cashCommissionTokenValue" FROM bookings ORDER BY id',
        ),
      ).toEqual([
        { cashCommissionTokenValue: '100.0000' },
        { cashCommissionTokenValue: '25.0000' },
      ]);
      expect(await db.query('SELECT balance FROM wallet_accounts')).toEqual([
        { balance: '100.00' },
      ]);
      expect(
        await db.query(
          'SELECT amount, "tokenQuantity" FROM payment_transactions WHERE id=1',
        ),
      ).toEqual([{ amount: '5000.00', tokenQuantity: null }]);
    });

    it('changes future quotes to 10 without touching old quotes, token counts or pending purchases', async () => {
      const migration = new TokenValue10Cdf1780000080000();
      await db.transaction(manager => migration.up(manager.queryRunner!));
      await db.query('INSERT INTO bookings(id) VALUES (10)');
      expect(await db.query('SELECT "cashCommissionTokenValue" FROM bookings ORDER BY id')).toEqual([
        { cashCommissionTokenValue: '100.0000' },
        { cashCommissionTokenValue: '25.0000' },
        { cashCommissionTokenValue: '10.0000' },
      ]);
      expect(await db.query('SELECT balance FROM wallet_accounts')).toEqual([{ balance: '100.00' }]);
      expect(await db.query('SELECT amount FROM payment_transactions WHERE id=1')).toEqual([{ amount: '5000.00' }]);
      await db.transaction(manager => migration.down(manager.queryRunner!));
      expect(await db.query('SELECT "cashCommissionTokenValue" FROM bookings WHERE id=10'))
        .toEqual([{ cashCommissionTokenValue: '10.0000' }]);
    });

    it('stores a purchase quantity without allowing invalid or non-topup quotes', async () => {
      await db.query(
        `INSERT INTO payment_transactions(id,purpose,amount,"tokenQuantity") VALUES (2,'wallet_top_up',1250,50)`,
      );
      expect(
        await db.query(
          'SELECT "tokenQuantity" FROM payment_transactions WHERE id=2',
        ),
      ).toEqual([{ tokenQuantity: '50.00' }]);
      await expect(
        db.query(
          `INSERT INTO payment_transactions(id,purpose,amount,"tokenQuantity") VALUES (3,'wallet_top_up',1250,0)`,
        ),
      ).rejects.toThrow('CHK_payment_token_quantity');
      await expect(
        db.query(
          `INSERT INTO payment_transactions(id,purpose,amount,"tokenQuantity") VALUES (4,'driver_payout',1250,50)`,
        ),
      ).rejects.toThrow('CHK_payment_token_quantity');
    });

    it('replaces the obsolete welcome promise idempotently without calling the grant', async () => {
      await db.query(`CREATE FUNCTION zwanga_grant_welcome_bonus(uid uuid) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN PERFORM 'Bienvenue chez Zwanga ! 5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer votre abonnement Pro.';
      RAISE EXCEPTION 'GRANT_MUST_NOT_RUN_DURING_MIGRATION'; END $$`);
      const migration = new WelcomeBonus25CdfCopy1780000071000();
      await db.transaction((manager) => migration.up(manager.queryRunner!));
      await db.transaction((manager) => migration.up(manager.queryRunner!));
      const [row] = await db.query(
        "SELECT pg_get_functiondef('zwanga_grant_welcome_bonus(uuid)'::regprocedure) AS definition",
      );
      expect(row.definition).toContain('1 250 FC');
      expect(row.definition).not.toContain('5 000 FC');
      expect(row.definition).toContain('GRANT_MUST_NOT_RUN_DURING_MIGRATION');
      expect(await db.query('SELECT balance FROM wallet_accounts')).toEqual([
        { balance: '100.00' },
      ]);
    });
  },
);
