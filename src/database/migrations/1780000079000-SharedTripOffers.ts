import { MigrationInterface, QueryRunner } from 'typeorm';

export class SharedTripOffers1780000079000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE driver_offers
      ADD COLUMN "existingTripId" uuid REFERENCES trips(id) ON DELETE RESTRICT,
      ADD COLUMN "sharedBookingId" uuid REFERENCES bookings(id) ON DELETE RESTRICT,
      ADD COLUMN "sharedTripConsentAt" timestamptz;
      CREATE INDEX "IDX_driver_offers_existing_trip" ON driver_offers ("existingTripId");
      CREATE UNIQUE INDEX "IDX_driver_offers_shared_booking" ON driver_offers ("sharedBookingId");
      ALTER TABLE driver_offers ADD CONSTRAINT "CHK_shared_offer_consent"
        CHECK ("existingTripId" IS NULL OR status <> 'accepted'
          OR ("sharedBookingId" IS NOT NULL AND "sharedTripConsentAt" IS NOT NULL));`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // A rollback must not silently erase a passenger's recorded consent.
    const [row] = await runner.query(`SELECT EXISTS (
      SELECT 1 FROM driver_offers WHERE "sharedTripConsentAt" IS NOT NULL
    ) AS used`);
    if (row.used)
      throw new Error(
        'Shared trip consents exist: archive them before reverting this migration.',
      );
    await runner.query(`ALTER TABLE driver_offers DROP CONSTRAINT "CHK_shared_offer_consent",
      DROP COLUMN "sharedTripConsentAt", DROP COLUMN "sharedBookingId", DROP COLUMN "existingTripId";`);
  }
}
