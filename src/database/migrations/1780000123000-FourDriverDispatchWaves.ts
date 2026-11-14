import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Four bounded invitation slots; the per-driver pending index remains untouched. */
export class FourDriverDispatchWaves1780000123000 implements MigrationInterface {
  name = 'FourDriverDispatchWaves1780000123000';
  async up(runner: QueryRunner) {
    if (!runner.isTransactionActive)
      throw new Error('Dispatch wave migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query(`ALTER TABLE trip_request_dispatch_offers ADD COLUMN "waveSlot" smallint NOT NULL DEFAULT 1
      CONSTRAINT dispatch_wave_slot_range CHECK ("waveSlot" BETWEEN 1 AND 4)`);
    await runner.query(`CREATE UNIQUE INDEX dispatch_pending_wave_slot_idx
      ON trip_request_dispatch_offers ("requestId", "waveSlot") WHERE sequential=true AND status='pending'`);
    await runner.query(`CREATE UNIQUE INDEX dispatch_one_pending_decision_idx
      ON trip_request_dispatch_offers ("requestId") WHERE sequential=true AND status='pending' AND phase<>'driver'`);
    await runner.query(
      'DROP INDEX dispatch_one_sequential_pending_request_idx',
    );
  }
  async down(runner: QueryRunner) {
    if (!runner.isTransactionActive)
      throw new Error('Dispatch wave rollback requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    // Do not delete live offers to make rollback succeed. Stop allocators and drain first.
    await runner.query(
      'LOCK TABLE trip_request_dispatch_offers IN SHARE ROW EXCLUSIVE MODE',
    );
    const [row] =
      (await runner.query(`SELECT EXISTS (SELECT 1 FROM trip_request_dispatch_offers
      WHERE sequential=true AND status='pending') AS live`)) as {
        live: boolean;
      }[];
    if (row.live)
      throw new Error('Drain live sequential invitations before rollback.');
    await runner.query(`CREATE UNIQUE INDEX dispatch_one_sequential_pending_request_idx
      ON trip_request_dispatch_offers ("requestId") WHERE sequential=true AND status='pending'`);
    await runner.query('DROP INDEX dispatch_one_pending_decision_idx');
    await runner.query('DROP INDEX dispatch_pending_wave_slot_idx');
    await runner.query(
      'ALTER TABLE trip_request_dispatch_offers DROP COLUMN "waveSlot"',
    );
  }
}
