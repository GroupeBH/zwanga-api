import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCashReceipts1780000039000 implements MigrationInterface {
  name = 'AddCashReceipts1780000039000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    // Nullable, no historical backfill: arrival never proves that cash was received.
    await queryRunner.query(`ALTER TABLE bookings
      ADD COLUMN "cashReceivedAt" timestamptz NULL,
      ADD COLUMN "cashReceivedByDriverId" uuid NULL,
      ADD COLUMN "cashReceivedAmount" numeric(10,2) NULL`);
    await queryRunner.query(`ALTER TABLE bookings ADD CONSTRAINT "CHK_booking_cash_receipt"
      CHECK (("cashReceivedAt" IS NULL AND "cashReceivedByDriverId" IS NULL AND "cashReceivedAmount" IS NULL)
        OR ("cashReceivedAt" IS NOT NULL AND "cashReceivedByDriverId" IS NOT NULL
          AND "cashReceivedAmount" IS NOT NULL AND "cashReceivedAmount" > 0
          AND "paymentMode" = 'cash' AND "paymentAmount" IS NOT NULL
          AND "cashReceivedAmount" = "paymentAmount" AND "paymentStatus" = 'not_required')) NOT VALID`);
    await queryRunner.query(`ALTER TABLE bookings VALIDATE CONSTRAINT "CHK_booking_cash_receipt"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`ALTER TABLE bookings DROP CONSTRAINT "CHK_booking_cash_receipt",
      DROP COLUMN "cashReceivedAmount", DROP COLUMN "cashReceivedByDriverId", DROP COLUMN "cashReceivedAt"`);
  }
}
