import { MigrationInterface, QueryRunner } from 'typeorm';
export class ZwangaProSettlements1780000138000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Zwanga Pro requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`ALTER TABLE driver_earnings ADD COLUMN "proRepaymentAmount" numeric(12,2) NOT NULL DEFAULT 0 CHECK("proRepaymentAmount">=0),
      ADD COLUMN "proCreditPending" boolean NOT NULL DEFAULT false;
      CREATE TABLE pro_credit_work (
        "earningId" uuid PRIMARY KEY REFERENCES driver_earnings(id), version integer NOT NULL DEFAULT 1,
        "processedVersion" integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0,
        "retryAt" timestamptz NOT NULL DEFAULT now(), "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(), CHECK(version>="processedVersion")
      );
      CREATE INDEX pro_work_pending ON pro_credit_work("retryAt","earningId") WHERE version>"processedVersion";
      CREATE TABLE pro_credit_allocations (
        "earningId" uuid NOT NULL REFERENCES driver_earnings(id), "creditId" uuid NOT NULL REFERENCES asset_credits(id),
        "driverMinor" bigint NOT NULL CHECK("driverMinor">=0), "platformMinor" bigint NOT NULL CHECK("platformMinor">=0),
        "fixedMinor" bigint NOT NULL DEFAULT 0 CHECK("fixedMinor">=0 AND "fixedMinor"<="driverMinor"),
        "journalIds" jsonb NOT NULL, version integer NOT NULL, PRIMARY KEY("earningId","creditId")
      );
      CREATE INDEX pro_allocation_credit ON pro_credit_allocations("creditId");
      CREATE FUNCTION zwanga_pro_reserve_earning() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' AND ROW(NEW."grossAmount",NEW."netAmount",NEW."commissionAmount",NEW.status,NEW."paymentMode",NEW."assetRepaymentAmount",NEW.currency)
          IS NOT DISTINCT FROM ROW(OLD."grossAmount",OLD."netAmount",OLD."commissionAmount",OLD.status,OLD."paymentMode",OLD."assetRepaymentAmount",OLD.currency) THEN RETURN NEW; END IF;
        IF (NEW.currency='CDF' AND EXISTS(SELECT 1 FROM asset_credits c WHERE c."driverId"=NEW."driverId"
          AND c."policyVersion"='zwanga-pro-v1' AND c.status='active' AND c."activatedAt"<=NEW."createdAt"))
          OR EXISTS(SELECT 1 FROM pro_credit_work w WHERE w."earningId"=NEW.id) THEN
          NEW."proCreditPending":=NEW.status='available';
        END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION zwanga_pro_enqueue_earning() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' AND ROW(NEW."grossAmount",NEW."netAmount",NEW."commissionAmount",NEW.status,NEW."paymentMode",NEW."assetRepaymentAmount",NEW.currency)
          IS NOT DISTINCT FROM ROW(OLD."grossAmount",OLD."netAmount",OLD."commissionAmount",OLD.status,OLD."paymentMode",OLD."assetRepaymentAmount",OLD.currency) THEN RETURN NEW; END IF;
        IF (NEW.currency='CDF' AND NEW."proCreditPending") OR EXISTS(SELECT 1 FROM pro_credit_work w WHERE w."earningId"=NEW.id) THEN
          INSERT INTO pro_credit_work("earningId") VALUES(NEW.id) ON CONFLICT("earningId")
            DO UPDATE SET version=pro_credit_work.version+1,"updatedAt"=clock_timestamp(),"retryAt"=now(),attempts=0;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER pro_reserve_earning BEFORE INSERT OR UPDATE OF "grossAmount","netAmount","commissionAmount",status,"paymentMode","assetRepaymentAmount",currency
        ON driver_earnings FOR EACH ROW EXECUTE FUNCTION zwanga_pro_reserve_earning();
      CREATE TRIGGER pro_enqueue_earning AFTER INSERT OR UPDATE OF "grossAmount","netAmount","commissionAmount",status,"paymentMode","assetRepaymentAmount",currency
        ON driver_earnings FOR EACH ROW EXECUTE FUNCTION zwanga_pro_enqueue_earning();
      CREATE FUNCTION zwanga_pro_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM pro_credit_contracts WHERE "creditId"=OLD."creditId") THEN RAISE EXCEPTION 'ZWANGA_PRO_IMMUTABLE'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER pro_entry_immutable BEFORE UPDATE OR DELETE ON asset_credit_entries FOR EACH ROW EXECUTE FUNCTION zwanga_pro_entry_immutable();
      CREATE FUNCTION zwanga_pro_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cid uuid; actual bigint; expected bigint;
      BEGIN
        IF TG_TABLE_NAME='asset_credits' THEN cid:=NEW.id; ELSE cid:=NEW."creditId"; END IF;
        IF NOT EXISTS(SELECT 1 FROM pro_credit_contracts WHERE "creditId"=cid) THEN RETURN NULL; END IF;
        SELECT "paidMinor" INTO actual FROM asset_credits WHERE id=cid;
        SELECT coalesce(sum("amountMinor"),0) INTO expected FROM asset_credit_entries WHERE "creditId"=cid;
        IF actual<>expected THEN RAISE EXCEPTION 'ZWANGA_PRO_UNBALANCED_DEBT'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER pro_balance_credit AFTER INSERT OR UPDATE ON asset_credits
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zwanga_pro_balance_check();
      CREATE CONSTRAINT TRIGGER pro_balance_entry AFTER INSERT ON asset_credit_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zwanga_pro_balance_check();
    `);
  }
  down(): Promise<void> {
    throw Error(
      'Pending reservations and journals must be reconciled; use a forward migration.',
    );
  }
}
