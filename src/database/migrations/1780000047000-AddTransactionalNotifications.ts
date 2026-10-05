import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTransactionalNotifications1780000047000 implements MigrationInterface {
  name = 'AddTransactionalNotifications1780000047000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE notifications ADD COLUMN "eventKey" varchar(200)',
    );
    await runner.query(
      'CREATE UNIQUE INDEX "UQ_notifications_event_key" ON notifications ("eventKey")',
    );
    await runner.query(`CREATE INDEX "IDX_notifications_outbox_pending"
      ON notifications ("createdAt", id)
      WHERE "eventKey" IS NOT NULL AND status = 'pending' AND "errorMessage" IS NULL AND "isActive" = true`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Losing event identities would allow replays to produce duplicate financial alerts.
    await runner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM notifications WHERE "eventKey" IS NOT NULL) THEN
        RAISE EXCEPTION 'Transactional notification history exists; rollback refused';
      END IF;
    END $$`);
    await runner.query('DROP INDEX "IDX_notifications_outbox_pending"');
    await runner.query('DROP INDEX "UQ_notifications_event_key"');
    await runner.query('ALTER TABLE notifications DROP COLUMN "eventKey"');
  }
}
