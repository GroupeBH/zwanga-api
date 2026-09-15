import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRideDeclarations1780000035000 implements MigrationInterface {
  name = 'AddRideDeclarations1780000035000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE bookings
      ADD COLUMN "rideDeclarations" jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN "rideEffectsPending" jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN "rideEffectsVersion" integer NOT NULL DEFAULT 0,
      ADD COLUMN "rideEffectsRetryAt" timestamptz,
      ADD CONSTRAINT "CHK_booking_ride_effect" CHECK (jsonb_typeof("rideEffectsPending") = 'array' AND "rideEffectsPending" <@ '["pickup","dropoff"]'::jsonb AND jsonb_array_length("rideEffectsPending") <= 2),
      ADD CONSTRAINT "CHK_booking_ride_declarations_object" CHECK (jsonb_typeof("rideDeclarations") = 'object')`);
    await queryRunner.query(`CREATE INDEX "IDX_bookings_pending_ride_effects"
      ON bookings ("rideEffectsRetryAt") WHERE jsonb_array_length("rideEffectsPending") > 0`);
  }
  async down(): Promise<void> {
    throw new Error('Archive ride declarations and pending settlements explicitly before rollback.');
  }
}
