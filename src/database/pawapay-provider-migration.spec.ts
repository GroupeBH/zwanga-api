import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import { AddPawapayPaymentProvider1780000042000 } from './migrations/1780000042000-AddPawapayPaymentProvider';
import { AddPawapayRefunds1780000045000 } from './migrations/1780000045000-AddPawapayRefunds';

// Opt in to a disposable local cluster; never connect to the application database.
const pgBin = process.env.PAWAPAY_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'PawaPay migrations in one PostgreSQL transaction',
  () => {
    let directory: string;
    let started = false;
    let source: DataSource;
    let runner: QueryRunner;

    const executable = (name: string) =>
      join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-pawapay-test-'));
      execFileSync(
        executable('initdb'),
        [
          '-D',
          directory,
          '-U',
          'pawapay_test_owner',
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
          const address = server.address() as { port: number };
          server.close(() => done(address.port));
        });
      });
      try {
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
          // On Windows a child postgres process can inherit a pipe and keep
          // execFileSync waiting after pg_ctl exits; diagnostics go to the log.
          { windowsHide: true, stdio: 'ignore', timeout: 30000 },
        );
      } catch (error) {
        const log = join(directory, 'postgres.log');
        throw new Error(
          `Local PostgreSQL failed to start: ${existsSync(log) ? readFileSync(log, 'utf8') : String(error)}`,
        );
      }
      started = true;
      source = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'pawapay_test_owner',
        database: 'postgres',
        entities: [],
        synchronize: false,
      });
      await source.initialize();
      runner = source.createQueryRunner();
      await runner.connect();
      await runner.query(`
        CREATE TYPE payment_transactions_provider_enum AS ENUM ('flexpay');
        CREATE TYPE payment_transactions_status_enum AS ENUM ('pending', 'initiated', 'succeeded');
        CREATE TABLE users (id uuid PRIMARY KEY);
        CREATE TABLE payment_transactions (
          id uuid PRIMARY KEY,
          provider payment_transactions_provider_enum NOT NULL DEFAULT 'flexpay',
          status payment_transactions_status_enum NOT NULL DEFAULT 'pending',
          "updatedAt" timestamp NOT NULL DEFAULT now()
        );
      `);
      await runner.query('INSERT INTO payment_transactions (id) VALUES ($1)', [
        randomUUID(),
      ]);
    }, 90000);

    afterAll(async () => {
      if (runner && !runner.isReleased) await runner.release();
      if (source?.isInitialized) await source.destroy();
      if (
        directory &&
        (started || existsSync(join(directory, 'postmaster.pid')))
      ) {
        execFileSync(
          executable('pg_ctl'),
          ['-D', directory, '-m', 'immediate', '-w', 'stop'],
          {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 30000,
          },
        );
      }
      // Only remove this test's freshly allocated cluster directory.
      if (
        directory &&
        resolve(directory).startsWith(
          resolve(tmpdir()) + sep + 'zwanga-pawapay-test-',
        )
      ) {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30000);

    it('creates the pending index before the new enum value is committed', async () => {
      await runner.startTransaction();
      try {
        await new AddPawapayPaymentProvider1780000042000().up(runner);
        await new AddPawapayRefunds1780000045000().up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }

      const [index] = (await runner.query(`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'IDX_payment_transactions_provider_pending'
      `)) as Array<{ indexdef: string }>;
      expect(index.indexdef).toContain('(provider, "updatedAt")');
      expect(index.indexdef).not.toContain('pawapay');

      await runner.query(
        `INSERT INTO payment_transactions (id, provider) VALUES ($1, 'pawapay')`,
        [randomUUID()],
      );
      await new AddPawapayRefunds1780000045000().down(runner);
      const dropped = (await runner.query(`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'IDX_payment_transactions_provider_pending'
      `)) as unknown[];
      expect(dropped).toHaveLength(0);
    });
  },
);
