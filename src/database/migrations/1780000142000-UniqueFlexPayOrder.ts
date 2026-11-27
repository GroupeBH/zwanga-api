import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stop on historical duplicates; never silently delete or reassign payments. */
export class UniqueFlexPayOrder1780000142000 implements MigrationInterface {
  transaction = false;
  async up(q: QueryRunner): Promise<void> {
    if (q.isTransactionActive)
      throw new Error('UniqueFlexPayOrder requires transaction mode each');
    const [prior] = (await q.query(
      `SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`,
    )) as { statement_timeout: string; lock_timeout: string }[];
    try {
      await q.query(
        `SELECT set_config('statement_timeout','5min',false),set_config('lock_timeout','3s',false)`,
      );
      const duplicates = (await q.query(`SELECT 1 FROM payment_transactions
        WHERE provider='flexpay' AND "orderNumber" IS NOT NULL
        GROUP BY provider,"orderNumber" HAVING count(*) > 1 LIMIT 1`)) as unknown[];
      if (duplicates.length)
        throw new Error(
          'FLEXPAY_DUPLICATE_ORDERS: reconcile historical payments before migration',
        );
      const [existing] = (await q.query(
        `SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('"UQ_flexpay_provider_order"')`,
      )) as { indisvalid: boolean }[];
      if (existing && !existing.indisvalid)
        await q.query('DROP INDEX CONCURRENTLY "UQ_flexpay_provider_order"');
      await q.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_flexpay_provider_order"
        ON payment_transactions (provider,"orderNumber") WHERE provider='flexpay' AND "orderNumber" IS NOT NULL`);
      const [created] = (await q.query(
        `SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('"UQ_flexpay_provider_order"')`,
      )) as { indisvalid: boolean }[];
      if (!created?.indisvalid)
        throw new Error('Invalid FlexPay provider order index');
    } finally {
      await q.query(
        `SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)`,
        [prior.statement_timeout, prior.lock_timeout],
      );
    }
  }
  async down(q: QueryRunner): Promise<void> {
    if (q.isTransactionActive)
      throw new Error('UniqueFlexPayOrder requires transaction mode each');
    await q.query(
      'DROP INDEX CONCURRENTLY IF EXISTS "UQ_flexpay_provider_order"',
    );
  }
}
