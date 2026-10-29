import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A driver receiving an alert can still accept a different request from the list. */
export class SeparateRequestAttentionLease1780000101000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await this.change(runner, true);
  }
  async down(runner: QueryRunner) {
    await this.change(runner, false);
  }

  private async change(runner: QueryRunner, up: boolean) {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      const [settings] =
        (await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`)) as {
          lock_timeout: string;
          statement_timeout: string;
        }[];
      await runner.query(
        "SELECT set_config('lock_timeout','3s',true), set_config('statement_timeout','15s',true)",
      );
      await runner.query('DROP INDEX dispatch_one_pending_driver_idx');
      if (!up)
        await runner.query('DROP INDEX dispatch_one_pending_response_idx');
      await runner.query(`CREATE UNIQUE INDEX dispatch_one_pending_driver_idx
        ON trip_request_dispatch_offers ("driverId") WHERE status='pending'${up ? " AND phase='driver'" : ''}`);
      if (up)
        await runner.query(`CREATE UNIQUE INDEX dispatch_one_pending_response_idx
        ON trip_request_dispatch_offers ("driverId") WHERE status='pending' AND phase<>'driver'`);
      // Down fails transactionally if live attention and acceptance coexist. No rows are discarded.
      await runner.query(
        "SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
        [settings.lock_timeout, settings.statement_timeout],
      );
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive)
        await runner.rollbackTransaction();
      throw error;
    }
  }
}
