import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingPriceProposal1780000113000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE bookings ADD COLUMN "proposedPricePerSeat" integer NULL
      CONSTRAINT "bookings_proposed_price_positive" CHECK ("proposedPricePerSeat" BETWEEN 1 AND 99999999)`);
  }
  async down(q: QueryRunner): Promise<void> {
    // The agreed gross/payment amounts remain intact. Never roll back with pending offers.
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM bookings WHERE "proposedPricePerSeat" IS NOT NULL AND status = 'pending')
      THEN RAISE EXCEPTION 'Resolve pending booking price proposals before rollback'; END IF;
    END $$`);
    await q.query('ALTER TABLE bookings DROP COLUMN "proposedPricePerSeat"');
  }
}
