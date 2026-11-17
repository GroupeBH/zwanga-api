import { MigrationInterface, QueryRunner } from 'typeorm';
import { assetCreditCollections } from './sql/asset-credit-collections';
export class AssetCredits1780000124000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Asset credits require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT "CHK_wallet_ledger_type";
      ALTER TABLE wallet_ledger_entries ADD CONSTRAINT "CHK_wallet_ledger_type" CHECK (type IN ('top_up','loyalty_reward','booking_payment','booking_refund','booking_fare_adjustment','subscription_payment','subscription_reward','transfer_out','transfer_in','admin_adjustment','withdrawal','withdrawal_refund','cash_commission','cash_commission_refund','asset_credit_repayment'));`);
    await q.query(`
      CREATE TABLE asset_credit_products (kind text PRIMARY KEY CHECK(kind IN ('phone','vehicle','equipment')), enabled boolean NOT NULL DEFAULT false);
      INSERT INTO asset_credit_products VALUES ('phone',true),('vehicle',false),('equipment',false);
      CREATE TABLE asset_credit_requests (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"driverId" uuid NOT NULL REFERENCES users(id),"assetKind" text NOT NULL REFERENCES asset_credit_products(kind),notes text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','offered','closed')),"createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_asset_credit_request_open" ON asset_credit_requests("driverId","assetKind") WHERE status='submitted';
      CREATE INDEX "IDX_asset_requests_driver" ON asset_credit_requests("driverId","createdAt");
      CREATE INDEX "IDX_asset_requests_kind" ON asset_credit_requests("assetKind");
      CREATE TABLE asset_credits (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "driverId" uuid NOT NULL REFERENCES users(id),
        "assetKind" text NOT NULL REFERENCES asset_credit_products(kind), label text NOT NULL,
        "principalMinor" bigint NOT NULL CHECK("principalMinor">0 AND "principalMinor"<=1000000000000 AND "principalMinor"%10=0),
        "paidMinor" bigint NOT NULL DEFAULT 0, "dueMinor" bigint NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','active','settled','declined','cancelled')),
        terms text NOT NULL, "policyVersion" text NOT NULL DEFAULT 'asset-credit-v1',
        "validationReference" text NOT NULL, "deliveryReference" text, "assetReference" text,
        "createdBy" uuid NOT NULL REFERENCES users(id), "mutationId" uuid NOT NULL UNIQUE, "requestPayload" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "acceptedAt" timestamptz, "activatedAt" timestamptz,
        CHECK("paidMinor">=0 AND "dueMinor">=0 AND "paidMinor"+"dueMinor"<="principalMinor"),
        CHECK(status NOT IN ('active','settled') OR ("acceptedAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "deliveryReference" IS NOT NULL AND "assetReference" IS NOT NULL)),
        CHECK(status <> 'settled' OR "paidMinor"="principalMinor")
      );
      CREATE INDEX "IDX_asset_credit_driver" ON asset_credits("driverId",status,"activatedAt",id);
      CREATE INDEX "IDX_asset_credit_kind" ON asset_credits("assetKind");
      CREATE INDEX "IDX_asset_credit_creator" ON asset_credits("createdBy");
      CREATE UNIQUE INDEX "UQ_asset_credit_delivered_asset" ON asset_credits("assetKind",upper("assetReference")) WHERE "assetReference" IS NOT NULL;
      CREATE TABLE asset_credit_events (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"creditId" uuid NOT NULL REFERENCES asset_credits(id),"actorId" uuid NOT NULL REFERENCES users(id), action text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_asset_credit_events_credit" ON asset_credit_events("creditId","createdAt");
      CREATE INDEX "IDX_asset_credit_events_actor" ON asset_credit_events("actorId");
      CREATE TABLE asset_credit_entries (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"creditId" uuid NOT NULL REFERENCES asset_credits(id),
        "driverId" uuid NOT NULL REFERENCES users(id),"bookingId" uuid, kind text NOT NULL CHECK(kind IN ('trip_earning','trip_cash','wallet','reversal')),
        "amountMinor" bigint NOT NULL,"dueDeltaMinor" bigint NOT NULL DEFAULT 0,"sourceKey" text NOT NULL,
        "walletEntryId" uuid REFERENCES wallet_ledger_entries(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
        CHECK("amountMinor"<>0 OR "dueDeltaMinor"<>0)
      );
      CREATE INDEX "IDX_asset_entries_credit" ON asset_credit_entries("creditId","createdAt",id);
      CREATE INDEX "IDX_asset_entries_driver" ON asset_credit_entries("driverId");
      CREATE INDEX "IDX_asset_entries_source" ON asset_credit_entries("sourceKey");
      CREATE INDEX "IDX_asset_entries_booking" ON asset_credit_entries("bookingId");
      CREATE INDEX "IDX_asset_entries_wallet" ON asset_credit_entries("walletEntryId");
      CREATE TABLE asset_credit_sources ("sourceKey" text PRIMARY KEY,"driverId" uuid NOT NULL REFERENCES users(id),"targetMinor" bigint NOT NULL DEFAULT 0 CHECK("targetMinor">=0),"collectedMinor" bigint NOT NULL DEFAULT 0 CHECK("collectedMinor">=0));
      CREATE INDEX "IDX_asset_sources_driver" ON asset_credit_sources("driverId");
      CREATE TABLE asset_credit_wallet_mutations (id uuid PRIMARY KEY,"driverId" uuid NOT NULL REFERENCES users(id),"creditId" uuid NOT NULL REFERENCES asset_credits(id),"amountMinor" bigint NOT NULL CHECK("amountMinor">0),"createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_asset_mutations_driver" ON asset_credit_wallet_mutations("driverId");
      CREATE INDEX "IDX_asset_mutations_credit" ON asset_credit_wallet_mutations("creditId");
      ALTER TABLE driver_earnings ADD COLUMN "assetRepaymentAmount" numeric(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE driver_earnings ADD CONSTRAINT "CHK_driver_asset_repayment" CHECK("assetRepaymentAmount">=0 AND "assetRepaymentAmount"<="netAmount");
    `);
    await q.query(assetCreditCollections);
  }
  async down(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Asset credits require a transaction');
    const [{ count }] = await q.query('SELECT (SELECT count(*) FROM asset_credits) + (SELECT count(*) FROM asset_credit_requests) AS count');
    if (Number(count))
      throw Error(
        'Asset credit records must be archived and reconciled before reverting.',
      );
    await q.query(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT "CHK_wallet_ledger_type";
      ALTER TABLE wallet_ledger_entries ADD CONSTRAINT "CHK_wallet_ledger_type" CHECK (type IN ('top_up','loyalty_reward','booking_payment','booking_refund','booking_fare_adjustment','subscription_payment','subscription_reward','transfer_out','transfer_in','admin_adjustment','withdrawal','withdrawal_refund','cash_commission','cash_commission_refund'));`);
    await q.query(`DROP TRIGGER asset_earning_collection ON driver_earnings; DROP TRIGGER asset_cash_collection ON bookings;
      DROP FUNCTION zwanga_asset_earning_trigger(); DROP FUNCTION zwanga_asset_cash_trigger();
      DROP FUNCTION zwanga_asset_collect(uuid,uuid,text,bigint,timestamptz);
      DROP FUNCTION zwanga_asset_wallet_repay(uuid,uuid,bigint,uuid);
      DROP FUNCTION zwanga_asset_wallet_debit(uuid,bigint,uuid,text);
      ALTER TABLE driver_earnings DROP COLUMN "assetRepaymentAmount";
      DROP TABLE asset_credit_wallet_mutations,asset_credit_sources,asset_credit_entries,asset_credit_events,asset_credits,asset_credit_requests,asset_credit_products;`);
  }
}
