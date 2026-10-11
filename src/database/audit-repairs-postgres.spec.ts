import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { ReconcileFlexPayDeposits1780000067000 } from './migrations/1780000067000-ReconcileFlexPayDeposits';
import { VerifiedRatingInteractions1780000068000 } from './migrations/1780000068000-VerifiedRatingInteractions';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('Audit repairs on isolated PostgreSQL', () => {
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  const historical = randomUUID();
  beforeAll(async () => {
    db = await cluster.start();
    await db.query(`CREATE TABLE payment_transactions (id uuid PRIMARY KEY, provider text NOT NULL, purpose text NOT NULL, status text NOT NULL, "orderNumber" text);
      CREATE TABLE ratings (id uuid PRIMARY KEY, "raterId" uuid, "ratedUserId" uuid, "tripId" uuid);
      INSERT INTO ratings VALUES ('${historical}', '${historical}', '${historical}', '${historical}');
      INSERT INTO ratings VALUES ('${randomUUID()}', '${historical}', '${historical}', '${historical}');`);
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await new ReconcileFlexPayDeposits1780000067000().up(runner);
      await new VerifiedRatingInteractions1780000068000().up(runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }, 120000);
  afterAll(() => cluster.stop(), 40000);
  beforeEach(async () => {
    await db.query('TRUNCATE payment_transactions CASCADE');
  });
  async function add(purpose = 'wallet_top_up') {
    const id = randomUUID();
    await db.query('INSERT INTO payment_transactions VALUES ($1,$2,$3,$4,$5)', [
      id,
      'flexpay',
      purpose,
      'initiated',
      'order',
    ]);
    await db.query(
      'UPDATE payment_reconciliation_jobs SET "nextAttemptAt" = now()',
    );
    return id;
  }
  it('queues deposits atomically and excludes payouts', async () => {
    const id = await add();
    await add('driver_payout');
    await db.query(
      'UPDATE payment_transactions SET status = $2 WHERE id = $1',
      [id, 'succeeded'],
    );
    expect(
      await db.query('SELECT "paymentId" FROM payment_reconciliation_jobs'),
    ).toEqual([{ paymentId: id }]);
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(
      'INSERT INTO payment_transactions VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), 'flexpay', 'wallet_top_up', 'pending', null],
    );
    await runner.rollbackTransaction();
    await runner.release();
    expect(
      (await db.query('SELECT * FROM payment_reconciliation_jobs')).length,
    ).toBe(1);
  });
  it('does not let two workers claim the same payment', async () => {
    const id = await add();
    const reconcileFlexPayDeposit = jest.fn(async () => true);
    const a = new PaymentReconciliationService(db, {
      reconcileFlexPayDeposit,
    } as never);
    const b = new PaymentReconciliationService(db, {
      reconcileFlexPayDeposit,
    } as never);
    await Promise.all([a.reconcile(), b.reconcile()]);
    expect(reconcileFlexPayDeposit).toHaveBeenCalledTimes(1);
    expect(reconcileFlexPayDeposit).toHaveBeenCalledWith(id);
    expect(
      (
        await db.query('SELECT "completedAt" FROM payment_reconciliation_jobs')
      )[0].completedAt,
    ).not.toBeNull();
  });
  it('recovers an expired lease and retries a domain error without marking complete', async () => {
    const id = await add();
    await db.query(
      `UPDATE payment_reconciliation_jobs SET "leaseToken" = $1, "leaseUntil" = now() - interval '1 minute'`,
      [randomUUID()],
    );
    const reconcileFlexPayDeposit = jest
      .fn()
      .mockRejectedValueOnce(new Error('domain unavailable'))
      .mockResolvedValue(true);
    const worker = new PaymentReconciliationService(db, {
      reconcileFlexPayDeposit,
    } as never);
    await worker.reconcile();
    const [pending] = await db.query(
      'SELECT * FROM payment_reconciliation_jobs',
    );
    expect(pending.completedAt).toBeNull();
    expect(pending.leaseToken).toBeNull();
    expect(pending.attempts).toBe(1);
    await db.query(
      'UPDATE payment_reconciliation_jobs SET "nextAttemptAt" = now() WHERE "paymentId" = $1',
      [id],
    );
    await worker.reconcile();
    expect(
      (
        await db.query('SELECT "completedAt" FROM payment_reconciliation_jobs')
      )[0].completedAt,
    ).not.toBeNull();
  });
  it('preserves historical duplicate reviews but prevents concurrent new duplicates', async () => {
    expect(
      (await db.query('SELECT * FROM ratings WHERE "verificationVersion" = 0'))
        .length,
    ).toBe(2);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const insert = () =>
      db.query('INSERT INTO ratings VALUES ($1,$2,$3,$4,1)', [
        randomUUID(),
        ...ids,
      ]);
    const results = await Promise.allSettled([insert(), insert()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('keeps a callback received during settlement pending until the new state is applied', async () => {
    const id = await add();
    const reconcileFlexPayDeposit = jest
      .fn()
      .mockImplementationOnce(async () => {
        await db.query(
          'UPDATE payment_transactions SET status = $2 WHERE id = $1',
          [id, 'succeeded'],
        );
        return true;
      })
      .mockResolvedValue(true);
    const worker = new PaymentReconciliationService(db, {
      reconcileFlexPayDeposit,
    } as never);
    await worker.reconcile();
    const [job] = await db.query('SELECT * FROM payment_reconciliation_jobs');
    expect(job.completedAt).toBeNull();
    expect(job.leaseToken).toBeNull();
    expect(job.revision).toBe(1);
    await db.query(
      'UPDATE payment_reconciliation_jobs SET "nextAttemptAt" = now()',
    );
    await worker.reconcile();
    expect(
      (
        await db.query('SELECT "completedAt" FROM payment_reconciliation_jobs')
      )[0].completedAt,
    ).not.toBeNull();
  });

  it('reopens completed work on a late status change but not on an identical callback', async () => {
    const id = await add();
    await db.query(
      'UPDATE payment_transactions SET status = $2 WHERE id = $1',
      [id, 'failed'],
    );
    await db.query(
      'UPDATE payment_reconciliation_jobs SET "nextAttemptAt" = now()',
    );
    const reconcileFlexPayDeposit = jest.fn().mockResolvedValue(true);
    await new PaymentReconciliationService(db, {
      reconcileFlexPayDeposit,
    } as never).reconcile();
    await db.query(
      'UPDATE payment_transactions SET status = $2 WHERE id = $1',
      [id, 'failed'],
    );
    expect(
      (
        await db.query('SELECT "completedAt" FROM payment_reconciliation_jobs')
      )[0].completedAt,
    ).not.toBeNull();
    await db.query(
      'UPDATE payment_transactions SET status = $2 WHERE id = $1',
      [id, 'succeeded'],
    );
    const [job] = await db.query('SELECT * FROM payment_reconciliation_jobs');
    expect(job.completedAt).toBeNull();
    expect(job.revision).toBe(2);
  });
});
