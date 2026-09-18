import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { AddPurchasedTokenWithdrawals1780000038000 } from './migrations/1780000038000-AddPurchasedTokenWithdrawals';

// Explicit opt-in, isolated throwaway cluster. Never reads application .env or DB URLs.
const pgBin = process.env.WALLET_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'purchased tokens migration on isolated PostgreSQL',
  () => {
    let directory: string;
    let started = false;
    let source: DataSource;
    let runner: QueryRunner;
    const migration = new AddPurchasedTokenWithdrawals1780000038000();
    const owner = randomUUID(),
      other = randomUUID();
    const account = randomUUID(),
      unverified = randomUUID();
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-wallet-test-'));
      const executable = (name: string) =>
        join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);
      execFileSync(
        executable('initdb'),
        [
          '-D',
          directory,
          '-U',
          'wallet_test_owner',
          '-A',
          'trust',
          '--no-locale',
          '-E',
          'UTF8',
        ],
        { windowsHide: true, stdio: 'pipe', timeout: 30000 },
      );
      const port = await new Promise<number>((done) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          server.close(() => done(port));
        });
      });
      // Windows child servers may inherit pipes and keep spawnSync waiting after
      // pg_ctl has exited; server diagnostics go to the isolated log instead.
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
        { windowsHide: true, stdio: 'ignore', timeout: 30000 },
      );
      started = true;
      source = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'wallet_test_owner',
        database: 'postgres',
        entities: [],
        synchronize: false,
      });
      await source.initialize();
      runner = source.createQueryRunner();
      await runner.connect();
      await runner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE wallet_accounts (id uuid PRIMARY KEY, "userId" uuid, balance numeric(12,2) NOT NULL);
      CREATE TABLE payment_transactions (id uuid PRIMARY KEY, "userId" uuid, status text, purpose text,
        "relatedEntityType" text, "relatedEntityId" text, "orderNumber" text, reference text, amount numeric, currency text, "rawCheckResponse" jsonb);
      CREATE TABLE wallet_ledger_entries (id uuid PRIMARY KEY, "accountId" uuid, "userId" uuid, type varchar(40),
        amount numeric(12,2), "relatedEntityType" text, "relatedEntityId" uuid, "paymentTransactionId" uuid,
        CONSTRAINT "CHK_wallet_ledger_type" CHECK (type IN ('top_up','booking_payment','loyalty_reward','transfer_in')));`);
      await runner.query(`INSERT INTO users VALUES ($1),($2)`, [owner, other]);
      await runner.query(
        `INSERT INTO wallet_accounts VALUES ($1,$2,110),($3,$4,50)`,
        [account, owner, unverified, other],
      );
      const purchase = randomUUID(),
        unproven = randomUUID();
      await runner.query(
        `INSERT INTO payment_transactions VALUES ($1,$2::uuid,'succeeded','wallet_top_up','wallet_top_up',$2::text,'order','reference',10000,'CDF',$3),
      ($4,$5::uuid,'succeeded','wallet_top_up','wallet_top_up',$5::text,'unknown','unknown',5000,'CDF',NULL)`,
        [
          purchase,
          owner,
          JSON.stringify({
            code: '0',
            transaction: {
              status: '0',
              orderNumber: 'order',
              reference: 'reference',
              amount: '10000',
              currency: 'CDF',
            },
          }),
          unproven,
          other,
        ],
      );
      await runner.query(
        `INSERT INTO wallet_ledger_entries (id,"accountId","userId",type,amount,"paymentTransactionId") VALUES
      ($1,$2,$3,'top_up',100,$4),($5,$2,$3,'loyalty_reward',30,NULL),($6,$2,$3,'booking_payment',-20,NULL),($7,$8,$9,'top_up',50,$10)`,
        [
          randomUUID(),
          account,
          owner,
          purchase,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          unverified,
          other,
          unproven,
        ],
      );
      await runner.startTransaction();
      try {
        await migration.up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
    }, 90000);

    afterAll(async () => {
      if (runner) await runner.release();
      if (source?.isInitialized) await source.destroy();
      if (
        directory &&
        (started || existsSync(join(directory, 'postmaster.pid')))
      )
        execFileSync(
          join(pgBin!, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'),
          ['-D', directory, '-m', 'immediate', '-w', 'stop'],
          { windowsHide: true, stdio: 'ignore', timeout: 30000 },
        );
      // Delete only the exact fresh test directory created above, never a configured DB directory.
      if (
        directory &&
        resolve(directory).startsWith(
          resolve(tmpdir()) + require('path').sep + 'zwanga-wallet-test-',
        )
      )
        rmSync(directory, { recursive: true, force: true });
    });

    it('preserves totals and only migrates a conservative proven purchased balance', async () => {
      const [verified] = await runner.query(
        `SELECT * FROM wallet_accounts WHERE id=$1`,
        [account],
      );
      expect(verified.balance).toBe('110.00');
      expect(verified.withdrawableBalance).toBe('80.00');
      const [unknown] = await runner.query(
        `SELECT * FROM wallet_accounts WHERE id=$1`,
        [unverified],
      );
      expect(unknown.balance).toBe('50.00');
      expect(unknown.withdrawableBalance).toBe('0.00');
      const [{ count }] = await runner.query(
        `SELECT COUNT(*) FROM wallet_ledger_entries WHERE "withdrawableAmount" IS NOT NULL`,
      );
      expect(count).toBe('0');
    });
    it('enforces cash-eligible balances, ledger allocations and idempotency in PostgreSQL', async () => {
      await expect(
        runner.query(
          `UPDATE wallet_accounts SET "withdrawableBalance"=111 WHERE id=$1`,
          [account],
        ),
      ).rejects.toThrow('CHK_wallet_accounts_withdrawable');
      await expect(
        runner.query(
          `UPDATE wallet_accounts SET "reservedWithdrawalBalance"=-1 WHERE id=$1`,
          [account],
        ),
      ).rejects.toThrow('CHK_wallet_accounts_withdrawable');
      await expect(
        runner.query(
          `UPDATE wallet_ledger_entries SET "withdrawableAmount"=999 WHERE type='top_up'`,
        ),
      ).rejects.toThrow('CHK_wallet_ledger_withdrawable_amount');
      const key = randomUUID();
      const insert = () =>
        runner.query(
          `INSERT INTO wallet_withdrawals ("userId","idempotencyKey",tokens,amount,"moneyPerToken",currency,phone)
      VALUES ($1,$2,10,1000,100,'CDF','243891234567')`,
          [owner, key],
        );
      await insert();
      await expect(insert()).rejects.toThrow('UQ_wallet_withdrawals_request');
    });
    it('refuses destructive rollback once withdrawals exist', async () => {
      await expect(migration.down(runner)).rejects.toThrow('Rollback refused');
      expect(
        (await runner.query(`SELECT COUNT(*) FROM wallet_withdrawals`))[0]
          .count,
      ).toBe('1');
    });
  },
);
