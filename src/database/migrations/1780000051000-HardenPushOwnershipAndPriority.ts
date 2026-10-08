import { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenPushOwnershipAndPriority1780000051000 implements MigrationInterface {
  name = 'HardenPushOwnershipAndPriority1780000051000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('SELECT pg_advisory_xact_lock(782341, 1)');
    // An ambiguous historical token has no provable owner: require re-registration,
    // never pick an arbitrary account to receive somebody else's private notifications.
    await runner.query(`UPDATE users SET "fcmToken" = NULL WHERE "fcmToken" IN (
      SELECT "fcmToken" FROM users WHERE "fcmToken" IS NOT NULL GROUP BY "fcmToken" HAVING count(*) > 1)`);
    await runner.query(`DELETE FROM driver_notification_clients WHERE "userId" IN (SELECT id FROM users WHERE "fcmToken" IS NULL)`);
    await runner.query(`DELETE FROM app_update_clients WHERE "userId" IN (SELECT id FROM users WHERE "fcmToken" IS NULL)`);
    await runner.query(`CREATE UNIQUE INDEX "UQ_users_push_token" ON users ("fcmToken") WHERE "fcmToken" IS NOT NULL`);
    await runner.query(`CREATE INDEX "IDX_notifications_urgent_outbox" ON notifications ("createdAt", id)
      WHERE "eventKey" IS NOT NULL AND "isActive" = true AND status IN ('pending', 'failed')
      AND data ->> 'type' IN ('new_booking', 'driver_dispatch_offer')`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "IDX_notifications_urgent_outbox"');
    await runner.query('DROP INDEX "UQ_users_push_token"');
    // Deliberately do not restore ambiguous device associations.
  }
}
