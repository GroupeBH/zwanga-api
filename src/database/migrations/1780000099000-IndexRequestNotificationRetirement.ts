import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive and compatible with the existing transactional migration runner.
 * It also accelerates the previous deployed relay during a rolling release. */
export class IndexRequestNotificationRetirement1780000099000 implements MigrationInterface {
  name = 'IndexRequestNotificationRetirement1780000099000';

  async up(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, async () => {
      await runner.query(`CREATE INDEX IF NOT EXISTS "IDX_notifications_active_request_type"
        ON notifications ((data->>'tripRequestId'), (data->>'type')) WHERE "isActive"=true`);
      // Do not silently accept an invalid index left by a manually interrupted
      // concurrent pre-build. Fail the migration without deleting any data/index.
      const [index] = await runner.query(`SELECT i.indisvalid FROM pg_index i
        WHERE i.indexrelid=to_regclass('"IDX_notifications_active_request_type"')`);
      if (!index?.indisvalid) throw new Error('IDX_notifications_active_request_type is not valid');
    });
  }

  async down(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, async () => {
      await runner.query('DROP INDEX IF EXISTS "IDX_notifications_active_request_type"');
    });
  }

  private async withBudget(runner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      const [previous] = await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      await runner.query("SELECT set_config('lock_timeout','5s',true), set_config('statement_timeout','30s',true)");
      await work();
      await runner.query("SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
        [previous.lock_timeout, previous.statement_timeout]);
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }
}
