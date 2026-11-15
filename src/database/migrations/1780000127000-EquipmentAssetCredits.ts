import { MigrationInterface, QueryRunner } from 'typeorm';

export class EquipmentAssetCredits1780000127000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Equipment credit migration requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`ALTER TABLE asset_credit_products DROP CONSTRAINT asset_credit_products_kind_check;
      ALTER TABLE asset_credit_products ADD CONSTRAINT asset_credit_products_kind_check
        CHECK(kind IN ('phone','vehicle','equipment','helmet','gps_tracker','delivery_equipment'));
      INSERT INTO asset_credit_products(kind,enabled) VALUES ('helmet',true),('gps_tracker',true),('delivery_equipment',true);
      UPDATE asset_credit_products SET enabled=true WHERE kind='equipment';`);
    // Preserve paused phones, vehicle availability and all existing contracts.
  }
  async down(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Equipment credit migration requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query('LOCK TABLE asset_credit_products IN ACCESS EXCLUSIVE MODE');
    const [{ used }] = await q.query(`SELECT EXISTS(SELECT 1 FROM asset_credits WHERE "assetKind" IN ('helmet','gps_tracker','delivery_equipment'))
      OR EXISTS(SELECT 1 FROM asset_credit_requests WHERE "assetKind" IN ('helmet','gps_tracker','delivery_equipment')) AS used`);
    if (used) throw Error('Equipment credit records must be preserved; pause products instead of reverting.');
    await q.query(`DELETE FROM asset_credit_products WHERE kind IN ('helmet','gps_tracker','delivery_equipment');
      UPDATE asset_credit_products SET enabled=false WHERE kind='equipment';
      ALTER TABLE asset_credit_products DROP CONSTRAINT asset_credit_products_kind_check;
      ALTER TABLE asset_credit_products ADD CONSTRAINT asset_credit_products_kind_check CHECK(kind IN ('phone','vehicle','equipment'));`);
  }
}
