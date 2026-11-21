import { MigrationInterface, QueryRunner } from 'typeorm';

export class AssetRepaymentPlans1780000133000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw Error('Repayment plans require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`ALTER TABLE asset_credits ADD COLUMN "repaymentPlans" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN "selectedPlanId" text,
      ADD CONSTRAINT "CHK_asset_plans_array" CHECK (jsonb_typeof("repaymentPlans")='array' AND jsonb_array_length("repaymentPlans")<=6);
      CREATE OR REPLACE FUNCTION zwanga_asset_cost_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE selected_months integer; choosing boolean;
      BEGIN
        choosing := OLD.status='offered' AND NEW.status='accepted' AND OLD."selectedPlanId" IS NULL
          AND NEW."selectedPlanId" IS NOT NULL AND jsonb_array_length(OLD."repaymentPlans")>0;
        IF choosing THEN
          SELECT (p->>'months')::integer INTO selected_months FROM jsonb_array_elements(OLD."repaymentPlans") p WHERE p->>'id'=NEW."selectedPlanId";
          IF selected_months IS NULL OR NEW."installmentCount" IS DISTINCT FROM selected_months OR NEW."installmentPeriod"<>'month'
            THEN RAISE EXCEPTION 'ASSET_PLAN_INVALID'; END IF;
        END IF;
        IF NEW."repaymentPlans" IS DISTINCT FROM OLD."repaymentPlans"
          OR (NOT choosing AND ROW(NEW."selectedPlanId",NEW."installmentCount") IS DISTINCT FROM ROW(OLD."selectedPlanId",OLD."installmentCount"))
          OR (NEW.status IN ('accepted','active','settled') AND jsonb_array_length(NEW."repaymentPlans")>0 AND NEW."selectedPlanId" IS NULL)
          OR ROW(NEW."cashPriceMinor",NEW."creditFeeMinor",NEW."installmentPeriod",NEW."costDisclosureVersion")
            IS DISTINCT FROM ROW(OLD."cashPriceMinor",OLD."creditFeeMinor",OLD."installmentPeriod",OLD."costDisclosureVersion")
          OR (OLD."costDisclosureVersion" IS NOT NULL AND
            (ROW(NEW."principalMinor",NEW."repaymentBps",NEW.terms,NEW."policyVersion") IS DISTINCT FROM ROW(OLD."principalMinor",OLD."repaymentBps",OLD.terms,OLD."policyVersion")
            OR (OLD."activatedAt" IS NOT NULL AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt")))
          THEN RAISE EXCEPTION 'ASSET_COST_IMMUTABLE'; END IF;
        RETURN NEW;
      END $$;`);
  }
  async down(): Promise<void> {
    // The previous trigger cannot preserve accepted plan evidence. Roll forward instead.
    throw Error('Repayment plan choices and contractual evidence must be preserved; use a forward migration.');
  }
}
