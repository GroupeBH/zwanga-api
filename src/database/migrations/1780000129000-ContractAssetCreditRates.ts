import { MigrationInterface, QueryRunner } from 'typeorm';
import { assetCreditCollections } from './sql/asset-credit-collections';
import { contractAssetCollections } from './sql/contract-asset-collections';

// Reuse the immutable v1 allocator, limiting its FIFO pool to legacy contracts.
const legacyStart = assetCreditCollections.indexOf('CREATE FUNCTION zwanga_asset_collect(');
const legacyEnd = assetCreditCollections.indexOf('CREATE FUNCTION zwanga_asset_earning_trigger()');
const originalLegacy = assetCreditCollections.slice(legacyStart, legacyEnd).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
const legacyFilter = `WHERE "driverId"=did AND status='active' AND "activatedAt"<=earned_at`;

export class ContractAssetCreditRates1780000129000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Contract rates require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`ALTER TABLE asset_credits ADD COLUMN "repaymentBps" smallint NOT NULL DEFAULT 500;
      ALTER TABLE asset_credits ADD CONSTRAINT "CHK_asset_credit_rate" CHECK(
        "repaymentBps" BETWEEN 1 AND 9500 AND "policyVersion" IN ('asset-credit-v1','asset-credit-v2')
        AND ("policyVersion"<>'asset-credit-v1' OR "repaymentBps"=500));
      CREATE TABLE asset_credit_rate_sources (
        "sourceKey" text PRIMARY KEY,"driverId" uuid NOT NULL REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_asset_rate_sources_driver" ON asset_credit_rate_sources("driverId");
      CREATE TABLE asset_credit_rate_allocations (
        "sourceKey" text NOT NULL REFERENCES asset_credit_rate_sources("sourceKey"),
        "creditId" uuid NOT NULL REFERENCES asset_credits(id),"repaymentBps" smallint NOT NULL CHECK("repaymentBps" BETWEEN 1 AND 9500),
        "targetMinor" bigint NOT NULL DEFAULT 0 CHECK("targetMinor">=0),
        "collectedMinor" bigint NOT NULL DEFAULT 0 CHECK("collectedMinor">=0),
        "dueDeltaMinor" bigint NOT NULL DEFAULT 0,
        PRIMARY KEY("sourceKey","creditId"));
      CREATE INDEX "IDX_asset_rate_allocations_credit" ON asset_credit_rate_allocations("creditId");
      UPDATE asset_credit_products SET enabled=true WHERE kind='vehicle';`);
    if (legacyStart < 0 || legacyEnd <= legacyStart || !originalLegacy.includes(legacyFilter)) throw Error('Legacy allocator not found');
    await q.query(originalLegacy.replace(legacyFilter, `${legacyFilter} AND "policyVersion"='asset-credit-v1'`)
      .replace('FROM asset_credit_entries WHERE', `FROM asset_credit_entries WHERE "creditId" IN (SELECT id FROM asset_credits WHERE "policyVersion"='asset-credit-v1') AND`));
    await q.query(contractAssetCollections);
  }
  async down(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Contract rates require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query('LOCK TABLE asset_credit_products,asset_credits,asset_credit_requests IN ACCESS EXCLUSIVE MODE');
    const [{ used }] = await q.query(`SELECT EXISTS(SELECT 1 FROM asset_credits WHERE "policyVersion"='asset-credit-v2' OR "assetKind"='vehicle')
      OR EXISTS(SELECT 1 FROM asset_credit_requests WHERE "assetKind"='vehicle') AS used`);
    if (used) throw Error('Contract rate records must be preserved; pause products instead.');
    const triggers = assetCreditCollections.slice(legacyEnd).replaceAll('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
      .replace(/^CREATE TRIGGER.*$/gm, '');
    await q.query(triggers);
    await q.query(originalLegacy);
    await q.query(`DROP FUNCTION zwanga_asset_collect_rates(uuid,uuid,text,bigint,bigint,timestamptz);
      DROP TABLE asset_credit_rate_allocations,asset_credit_rate_sources;
      ALTER TABLE asset_credits DROP CONSTRAINT "CHK_asset_credit_rate", DROP COLUMN "repaymentBps";
      UPDATE asset_credit_products SET enabled=false WHERE kind='vehicle';`);
  }
}
