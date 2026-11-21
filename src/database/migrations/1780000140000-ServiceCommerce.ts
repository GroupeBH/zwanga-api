import { MigrationInterface, QueryRunner } from 'typeorm';

export class ServiceCommerce1780000140000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Commerce migration requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`CREATE TABLE pro_commerce_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE,
      name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
      kind text NOT NULL CHECK(kind IN ('equipment','phone','accessories','document','vehicle')),
      enabled boolean NOT NULL DEFAULT true
    );
    INSERT INTO pro_commerce_categories(code,name,kind) VALUES
      ('conducteur-livreur','Équipements conducteur et livreur','equipment'),
      ('telephones','Téléphones','phone'), ('accessoires','Autres accessoires','accessories'),
      ('documents','Documents','document'), ('vehicules','Véhicules','vehicle');
    ALTER TABLE pro_credit_products ADD COLUMN "categoryId" uuid REFERENCES pro_commerce_categories(id),
      ADD COLUMN commerce jsonb, ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
    CREATE INDEX pro_product_category ON pro_credit_products("categoryId",id) WHERE enabled;
    ALTER TABLE pro_credit_products DROP CONSTRAINT pro_credit_products_kind_check;
    ALTER TABLE pro_credit_products ADD CONSTRAINT pro_credit_products_kind_check CHECK(kind IN ('document','phone','equipment','vehicle'));
    -- Discounts are distinct ledger credits, never real cash receipts. Historical principals stay immutable.
    ALTER TABLE asset_credit_entries DROP CONSTRAINT IF EXISTS "CHK_asset_entry_kind";
    `);
    // The original inline CHECK has a generated name. Identify only the kind constraint on this table.
    const checks: { conname: string }[] =
      await q.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='asset_credit_entries'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%kind%trip_earning%'`);
    for (const c of checks)
      await q.query(
        `ALTER TABLE asset_credit_entries DROP CONSTRAINT "${c.conname.replace(/"/g, '""')}"`,
      );
    await q.query(`ALTER TABLE asset_credit_entries ADD CONSTRAINT "CHK_asset_entry_kind"
      CHECK(kind IN ('trip_earning','trip_cash','wallet','reversal','discount'));
      CREATE UNIQUE INDEX pro_credit_one_early_discount ON asset_credit_entries("creditId") WHERE kind='discount';`);
  }
  down(): Promise<void> {
    throw Error(
      'Commercial contracts and discounts must be preserved; use a forward migration.',
    );
  }
}
