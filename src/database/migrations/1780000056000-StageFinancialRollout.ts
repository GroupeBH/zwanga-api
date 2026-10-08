import { MigrationInterface, QueryRunner } from 'typeorm';

/** Expand first, activate only after every old ECS task has stopped. */
export class StageFinancialRollout1780000056000 implements MigrationInterface {
  name = 'StageFinancialRollout1780000056000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error(
        'Financial preparation requires transactional migrations',
      );
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`
      CREATE TABLE financial_rollout (
        id boolean PRIMARY KEY DEFAULT true CHECK (id),
        enabled boolean NOT NULL DEFAULT false,
        "contractVersion" integer NOT NULL DEFAULT 1 CHECK ("contractVersion" = 1),
        "activatedAt" timestamptz
      );
      -- Never turn off a policy that already has financial history.
      INSERT INTO financial_rollout (id,enabled,"activatedAt")
        SELECT true, EXISTS(SELECT 1 FROM cash_commissions),
          CASE WHEN EXISTS(SELECT 1 FROM cash_commissions) THEN now() END;
      CREATE FUNCTION zwanga_cash_policy_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT enabled FROM financial_rollout WHERE id = true
      $$;
      ALTER TABLE trips ADD COLUMN "paymentModesExplicit" boolean NOT NULL DEFAULT false;
      ALTER TABLE recurring_trip_templates ADD COLUMN "paymentModesExplicit" boolean NOT NULL DEFAULT false;
      -- Preserve payment preferences already chosen by modern clients.
      UPDATE trips SET "paymentModesExplicit" = true WHERE "acceptedPaymentModes" <> ARRAY['electronic','points','cash']::text[];
      UPDATE recurring_trip_templates SET "paymentModesExplicit" = true WHERE "acceptedPaymentModes" <> ARRAY['electronic','points','cash']::text[];
    `);

    // Keep the already installed financial algorithms unchanged. Only gate entry
    // to their triggers; pg_get_functiondef preserves their exact deployed body.
    for (const name of [
      'zwanga_booking_cash_guard',
      'zwanga_request_cash_guard',
      'zwanga_cash_reconcile_credit',
    ]) {
      const [row] = await runner.query(
        'SELECT pg_get_functiondef($1::regprocedure) AS definition',
        [`${name}()`],
      );
      const legacy =
        name === 'zwanga_cash_reconcile_credit'
          ? 'RETURN NEW;'
          : `IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
           NEW."cashCommissionPolicyVersion" := 0; RETURN NEW;`;
      const promotePending =
        name === 'zwanga_cash_reconcile_credit'
          ? ''
          : `
        IF TG_OP <> 'DELETE' AND NEW."cashCommissionPolicyVersion" = 0 THEN
          IF (TG_OP = 'INSERT' AND NEW.status = 'pending') OR (TG_OP = 'UPDATE' AND OLD.status = 'pending') THEN
            NEW."cashCommissionPolicyVersion" := 2;
          END IF;
        END IF;`;
      if (!/^\s*BEGIN\b/im.test(row.definition))
        throw new Error(`Unexpected trigger body: ${name}`);
      await runner.query(
        row.definition.replace(
          /^\s*BEGIN\b/im,
          `BEGIN\n IF NOT zwanga_cash_policy_enabled() THEN ${legacy} END IF; ${promotePending}`,
        ),
      );
    }

    await runner.query(`CREATE OR REPLACE FUNCTION zwanga_publication_cash_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE r trip_requests%ROWTYPE;
      BEGIN
        IF NOT zwanga_cash_policy_enabled() OR NEW."isFree" OR NOT ('cash' = ANY(NEW."acceptedPaymentModes")) THEN RETURN NEW; END IF;
        IF NEW."isPrivate" THEN
          IF TG_OP = 'INSERT' AND NEW."tripRequestId" IS NOT NULL THEN
            SELECT * INTO r FROM trip_requests WHERE id = NEW."tripRequestId";
            IF r."paymentMode" = 'cash' AND NOT EXISTS (SELECT 1 FROM cash_commissions WHERE "requestId" = r.id AND "driverId" = NEW."driverId" AND state = 'reserved') THEN
              PERFORM zwanga_cash_check_capacity(NEW."driverId",NEW."pricePerSeat" * r."numberOfSeats");
            END IF;
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND ROW(NEW."pricePerSeat",NEW."totalSeats",NEW."acceptedPaymentModes") IS NOT DISTINCT FROM
          ROW(OLD."pricePerSeat",OLD."totalSeats",OLD."acceptedPaymentModes") THEN RETURN NEW; END IF;
        BEGIN
          PERFORM zwanga_cash_check_capacity(NEW."driverId",NEW."pricePerSeat" * NEW."totalSeats");
        EXCEPTION WHEN raise_exception THEN
          -- Legacy publication never explicitly chose cash. Keep the trip usable
          -- with its other modes; never bypass fees or alter an explicit choice.
          IF NOT NEW."paymentModesExplicit" AND SQLERRM IN ('CASH_COMMISSION_INSUFFICIENT','CASH_DEBT_OUTSTANDING')
            AND cardinality(array_remove(NEW."acceptedPaymentModes",'cash')) > 0 THEN
            NEW."acceptedPaymentModes" := array_remove(NEW."acceptedPaymentModes",'cash');
          ELSE RAISE; END IF;
        END;
        RETURN NEW;
      END $$;
      -- Old token registration cannot transfer unique ownership. Defer the
      -- index until the compatible writers are the only remaining servers.
      DO $$ BEGIN
        IF NOT zwanga_cash_policy_enabled() THEN DROP INDEX IF EXISTS "UQ_users_push_token"; END IF;
      END $$;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Do not revert financial history; deploy a compatible forward fix.',
      ),
    );
  }
}
