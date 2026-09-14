import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInterruptionPassengerDecisions1780000034000 implements MigrationInterface {
  name = 'AddInterruptionPassengerDecisions1780000034000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE driver_trip_interruption_confirmations
      ADD COLUMN IF NOT EXISTS "decision" text,
      ADD COLUMN IF NOT EXISTS "decisionAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "fareQuote" jsonb,
      ADD COLUMN IF NOT EXISTS "settledAt" timestamptz`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_interruption_unsettled_decisions"
      ON driver_trip_interruption_confirmations ("decisionAt") WHERE decision = 'stop' AND "settledAt" IS NULL`);
    await queryRunner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname = 'CHK_interruption_passenger_decision'
        AND conrelid = 'driver_trip_interruption_confirmations'::regclass) THEN
        ALTER TABLE driver_trip_interruption_confirmations
          ADD CONSTRAINT "CHK_interruption_passenger_decision"
          CHECK (decision IS NULL OR decision IN ('wait', 'stop'));
      END IF;
    END $$`);
    await queryRunner.query(`ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS "interruptionFareLocked" boolean NOT NULL DEFAULT false`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Quotes and decisions are financial audit data. Do not silently erase them.
    throw new Error(
      'Rollback requires an explicit archival plan for interruption decisions and fares.',
    );
  }
}
