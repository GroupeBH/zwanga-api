import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RideNotificationReceipts1780000093000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE ride_notification_receipts (
      "notificationId" uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
      "receivedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "displayedAt" timestamptz
    )`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE ride_notification_receipts');
  }
}
