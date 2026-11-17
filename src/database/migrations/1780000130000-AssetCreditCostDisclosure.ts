import { MigrationInterface, QueryRunner } from 'typeorm';

export class AssetCreditCostDisclosure1780000130000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Credit disclosure requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`ALTER TABLE asset_credits
      ADD COLUMN "cashPriceMinor" bigint,
      ADD COLUMN "creditFeeMinor" bigint,
      ADD COLUMN "installmentCount" smallint,
      ADD COLUMN "installmentPeriod" text,
      ADD COLUMN "costDisclosureVersion" text,
      ADD CONSTRAINT "CHK_asset_credit_cost" CHECK (
        ("costDisclosureVersion" IS NULL AND "cashPriceMinor" IS NULL AND "creditFeeMinor" IS NULL
          AND "installmentCount" IS NULL AND "installmentPeriod" IS NULL)
        OR ("costDisclosureVersion" IS NOT NULL AND "costDisclosureVersion"='asset-credit-cost-v1'
          AND "cashPriceMinor" IS NOT NULL AND "creditFeeMinor" IS NOT NULL
          AND "cashPriceMinor">=100 AND "creditFeeMinor">=0
          AND "cashPriceMinor"%10=0 AND "creditFeeMinor"%10=0
          AND "cashPriceMinor"+"creditFeeMinor"="principalMinor"
          AND (("installmentCount" IS NULL AND "installmentPeriod" IS NULL)
            OR ("installmentCount" IS NOT NULL AND "installmentPeriod" IS NOT NULL
              AND "installmentCount" BETWEEN 1 AND 120 AND "installmentCount"<="principalMinor"/10
              AND "installmentPeriod" IN ('week','month')))));
      CREATE FUNCTION zwanga_asset_cost_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW."cashPriceMinor",NEW."creditFeeMinor",NEW."installmentCount",NEW."installmentPeriod",NEW."costDisclosureVersion")
          IS DISTINCT FROM ROW(OLD."cashPriceMinor",OLD."creditFeeMinor",OLD."installmentCount",OLD."installmentPeriod",OLD."costDisclosureVersion")
          OR (OLD."costDisclosureVersion" IS NOT NULL AND
            (ROW(NEW."principalMinor",NEW."repaymentBps",NEW.terms,NEW."policyVersion")
              IS DISTINCT FROM ROW(OLD."principalMinor",OLD."repaymentBps",OLD.terms,OLD."policyVersion")
             OR (OLD."activatedAt" IS NOT NULL AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt")))
        THEN RAISE EXCEPTION 'ASSET_COST_IMMUTABLE'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER asset_cost_immutable BEFORE UPDATE ON asset_credits
        FOR EACH ROW EXECUTE FUNCTION zwanga_asset_cost_immutable();`);
  }
  async down(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Credit disclosure requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query('LOCK TABLE asset_credits IN ACCESS EXCLUSIVE MODE');
    const [{ used }] = await q.query('SELECT EXISTS(SELECT 1 FROM asset_credits WHERE "costDisclosureVersion" IS NOT NULL) AS used');
    if (used) throw Error('Credit costs and agreed schedules must be preserved.');
    await q.query(`DROP TRIGGER asset_cost_immutable ON asset_credits;
      DROP FUNCTION zwanga_asset_cost_immutable();
      ALTER TABLE asset_credits DROP CONSTRAINT "CHK_asset_credit_cost",
        DROP COLUMN "cashPriceMinor", DROP COLUMN "creditFeeMinor", DROP COLUMN "installmentCount",
        DROP COLUMN "installmentPeriod", DROP COLUMN "costDisclosureVersion";`);
  }
}
