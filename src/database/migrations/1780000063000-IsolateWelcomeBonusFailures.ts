import { MigrationInterface, QueryRunner } from 'typeorm';

/** Forward-only repair: never rewrite balances, historical credits or notifications. */
export class IsolateWelcomeBonusFailures1780000063000 implements MigrationInterface {
  name = 'IsolateWelcomeBonusFailures1780000063000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error('Welcome bonus repair requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '15s'");

    // Preserve deployed eligibility, promotion-only balances, idempotency and copy.
    const [row] = await runner.query(
      "SELECT pg_get_functiondef('zwanga_grant_welcome_bonus(uuid)'::regprocedure) AS definition",
    );
    const originalDefinition: unknown = row?.definition;
    if (typeof originalDefinition !== 'string')
      throw new Error('Missing welcome bonus function definition');
    let definition = originalDefinition;
    const replacements = [
      [
        "IF a.currency <> 'PTS' THEN",
        "IF a.currency IS NULL OR a.currency NOT IN ('PTS','POINTS') THEN",
      ],
      ["credited,'PTS','welcome_bonus'", "credited,a.currency,'welcome_bonus'"],
      ["'amount',50,'currency','PTS'", "'amount',50,'currency',a.currency"],
    ];
    for (const [previous, next] of replacements) {
      if (definition.includes(next) && !definition.includes(previous)) continue;
      if (definition.split(previous).length !== 2)
        throw new Error(
          'Unexpected welcome bonus definition; refusing currency repair',
        );
      definition = definition.replace(previous, next);
    }
    await runner.query(definition);
    await runner.query(`
      CREATE TABLE IF NOT EXISTS welcome_bonus_retry_state (
        "userId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        attempts integer NOT NULL CHECK (attempts > 0),
        "nextAttemptAt" timestamptz NOT NULL,
        "lastErrorCode" text NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION zwanga_try_grant_welcome_bonus(uid uuid)
      RETURNS boolean LANGUAGE plpgsql AS $$
      DECLARE credited boolean; failure_code text;
      BEGIN
        BEGIN
          credited := zwanga_grant_welcome_bonus(uid);
          DELETE FROM welcome_bonus_retry_state WHERE "userId" = uid;
          RETURN credited;
        EXCEPTION WHEN OTHERS THEN
          -- This subtransaction rolls back the WHOLE credit, ledger and outbox.
          -- Store a code only: SQLERRM can contain personal/financial data.
          failure_code := SQLSTATE;
          IF SQLERRM = 'WELCOME_BONUS_INVALID_WALLET_CURRENCY' THEN
            failure_code := 'WELCOME_BONUS_INVALID_WALLET_CURRENCY';
          END IF;
        END;
        INSERT INTO welcome_bonus_retry_state ("userId",attempts,"nextAttemptAt","lastErrorCode")
          VALUES (uid,1,now() + interval '15 minutes',failure_code)
          ON CONFLICT ("userId") DO UPDATE SET
            attempts = welcome_bonus_retry_state.attempts + 1,
            "nextAttemptAt" = EXCLUDED."nextAttemptAt",
            "lastErrorCode" = EXCLUDED."lastErrorCode", "updatedAt" = now();
        RAISE WARNING 'WELCOME_BONUS_DEFERRED user=% code=%', uid, failure_code;
        RETURN false;
      END $$;

      CREATE OR REPLACE FUNCTION zwanga_welcome_bonus_on_validation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous_timeout text := current_setting('lock_timeout'); target_uid uuid;
      BEGIN
        IF TG_TABLE_NAME = 'users' THEN
          IF TG_OP = 'UPDATE' THEN
            -- PIN, session, lastLoginAt and profile writes are NOT validations.
            IF OLD."isActive" IS NOT DISTINCT FROM NEW."isActive"
              AND OLD.status IS NOT DISTINCT FROM NEW.status
              AND OLD.role IS NOT DISTINCT FROM NEW.role THEN RETURN NEW; END IF;
          END IF;
          target_uid := NEW.id;
        ELSE
          IF TG_OP = 'UPDATE' THEN
            IF OLD.status IS NOT DISTINCT FROM NEW.status
              AND OLD."userId" IS NOT DISTINCT FROM NEW."userId" THEN RETURN NEW; END IF;
          END IF;
          target_uid := NEW."userId";
        END IF;
        PERFORM set_config('lock_timeout','250ms',true);
        BEGIN
          PERFORM zwanga_try_grant_welcome_bonus(target_uid);
        EXCEPTION WHEN OTHERS THEN
          -- Even failure to record a retry must not reject a KYC/account approval.
          -- The cron scans unclaimed eligible accounts again independently.
          RAISE WARNING 'WELCOME_BONUS_RETRY_UNAVAILABLE user=% sqlstate=%', target_uid, SQLSTATE;
        END;
        PERFORM set_config('lock_timeout',previous_timeout,true);
        RETURN NEW;
      END $$;

      CREATE OR REPLACE FUNCTION zwanga_backfill_welcome_bonus(batch_size integer DEFAULT 100)
      RETURNS integer LANGUAGE plpgsql AS $$
      DECLARE candidate uuid; credited integer := 0; examined integer := 0; target_role text;
      BEGIN
        IF batch_size IS NULL OR batch_size < 1 OR batch_size > 100 THEN
          RAISE EXCEPTION 'WELCOME_BONUS_INVALID_BATCH_SIZE';
        END IF;
        FOREACH target_role IN ARRAY ARRAY['driver','passenger'] LOOP
          FOR candidate IN
            SELECT u.id FROM users u
            WHERE u."isActive" = true AND u.status = 'active'
              AND u.role IN ('passenger','driver') AND u.role::text = target_role
              AND NOT EXISTS (SELECT 1 FROM welcome_bonus_grants g WHERE g."userId" = u.id)
              AND NOT EXISTS (SELECT 1 FROM welcome_bonus_retry_state r
                WHERE r."userId" = u.id AND r."nextAttemptAt" > now())
              AND (SELECT k.status FROM kyc_documents k WHERE k."userId" = u.id
                ORDER BY k."createdAt" DESC, k.id DESC LIMIT 1) = 'approved'
            ORDER BY u.id LIMIT (batch_size - examined) FOR NO KEY UPDATE OF u SKIP LOCKED
          LOOP
            examined := examined + 1;
            IF zwanga_try_grant_welcome_bonus(candidate) THEN credited := credited + 1; END IF;
          END LOOP;
          EXIT WHEN examined >= batch_size;
        END LOOP;
        RETURN credited;
      END $$;
    `);
  }

  down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Use a forward migration; do not restore blocking welcome bonus triggers.',
      ),
    );
  }
}
