import { MigrationInterface, QueryRunner } from 'typeorm';

/** Reuse the same grant/ledger identity: the driver catch-up is not a second bonus. */
export class PrioritizeDriverWelcomeBonus1780000054000 implements MigrationInterface {
  name = 'PrioritizeDriverWelcomeBonus1780000054000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`SET LOCAL lock_timeout = '5s'`);
    await runner.query(`
      CREATE OR REPLACE FUNCTION zwanga_backfill_welcome_bonus(batch_size integer DEFAULT 100)
      RETURNS integer LANGUAGE plpgsql AS $$
      DECLARE candidate uuid; credited integer := 0; examined integer := 0; target_role text;
      BEGIN
        IF batch_size IS NULL OR batch_size < 1 OR batch_size > 100 THEN
          RAISE EXCEPTION 'WELCOME_BONUS_INVALID_BATCH_SIZE';
        END IF;
        -- Drivers first, then use the remaining capacity for eligible passengers.
        -- Two bounded queries avoid sorting the entire eligible population by role.
        FOREACH target_role IN ARRAY ARRAY['driver','passenger'] LOOP
          FOR candidate IN
            SELECT u.id FROM users u
            WHERE u."isActive" = true AND u.status = 'active'
              AND u.role IN ('passenger','driver') AND u.role::text = target_role
              AND NOT EXISTS (SELECT 1 FROM welcome_bonus_grants g WHERE g."userId" = u.id)
              AND (SELECT k.status FROM kyc_documents k WHERE k."userId" = u.id
                ORDER BY k."createdAt" DESC, k.id DESC LIMIT 1) = 'approved'
            ORDER BY u.id LIMIT (batch_size - examined) FOR NO KEY UPDATE OF u SKIP LOCKED
          LOOP
            examined := examined + 1;
            IF zwanga_grant_welcome_bonus(candidate) THEN credited := credited + 1; END IF;
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
        'Keep welcome bonus financial history; use a reviewed forward migration.',
      ),
    );
  }
}
