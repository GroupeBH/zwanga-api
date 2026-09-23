import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnforceReferralBookingRewardRateCap1780000030000 implements MigrationInterface {
  name = 'EnforceReferralBookingRewardRateCap1780000030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_referral_rewards_booking_rate_cap'
            AND conrelid = 'public.referral_rewards'::regclass
        ) THEN
          ALTER TABLE referral_rewards
          ADD CONSTRAINT "CHK_referral_rewards_booking_rate_cap"
          CHECK (
            "sourceType" <> 'booking_payment'
            OR rate <= 0.010000
          ) NOT VALID;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM referral_rewards
          WHERE "sourceType" = 'booking_payment'
            AND rate > 0.010000
        ) THEN
          ALTER TABLE referral_rewards
          VALIDATE CONSTRAINT "CHK_referral_rewards_booking_rate_cap";
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE referral_rewards
      DROP CONSTRAINT IF EXISTS "CHK_referral_rewards_booking_rate_cap";
    `);
  }
}
