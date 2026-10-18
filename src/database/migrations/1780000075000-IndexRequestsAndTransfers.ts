import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexRequestsAndTransfers1780000075000 implements MigrationInterface {
  name = 'IndexRequestsAndTransfers1780000075000';
  async up(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, () => this.createIndexes(runner));
  }
  private async createIndexes(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE INDEX IF NOT EXISTS "IDX_requests_owner_page" ON trip_requests ("passengerId", "createdAt", id)');
    await runner.query(`CREATE INDEX IF NOT EXISTS "IDX_requests_open_page" ON trip_requests ("createdAt", id)
      WHERE status IN ('pending', 'offers_received') AND "immediateDispatch" = false AND "selectedDriverId" IS NULL AND "tripId" IS NULL`);
    await runner.query('CREATE INDEX IF NOT EXISTS "IDX_offers_owner_page" ON driver_offers ("driverId", "createdAt", id)');
    await runner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_transfer_direction" ON wallet_ledger_entries ("relatedEntityId", type)
      WHERE "relatedEntityType" = 'wallet_transfer' AND type IN ('transfer_out', 'transfer_in')`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, async () => {
      for (const name of ['UQ_wallet_transfer_direction', 'IDX_offers_owner_page', 'IDX_requests_open_page', 'IDX_requests_owner_page']) {
        await runner.query(`DROP INDEX IF EXISTS "${name}"`);
      }
    });
  }
  private async withBudget(runner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      const [previous] = await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      await runner.query("SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '30s', true)");
      await work();
      await runner.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        [previous.lock_timeout, previous.statement_timeout]);
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }
}
