import { MigrationInterface, QueryRunner } from 'typeorm';

export class IntercityDriverCategory1780000128000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Intercity migration requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`ALTER TABLE users DROP CONSTRAINT "CHK_users_driver_category";
      ALTER TABLE users ADD CONSTRAINT "CHK_users_driver_category"
        CHECK ("driverCategory" IS NULL OR "driverCategory" IN ('private','transport','intercity')) NOT VALID`);
  }
  async down(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Intercity migration requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
    const [{ used }] = await q.query(`SELECT EXISTS(SELECT 1 FROM users WHERE "driverCategory"='intercity') AS used`);
    if (used) throw Error('Intercity profiles must be preserved; cannot revert this category.');
    await q.query(`ALTER TABLE users DROP CONSTRAINT "CHK_users_driver_category";
      ALTER TABLE users ADD CONSTRAINT "CHK_users_driver_category"
        CHECK ("driverCategory" IS NULL OR "driverCategory" IN ('private','transport')) NOT VALID`);
  }
}
