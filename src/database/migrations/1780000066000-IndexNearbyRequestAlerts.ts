import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexNearbyRequestAlerts1780000066000 implements MigrationInterface {
  name = 'IndexNearbyRequestAlerts1780000066000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Urgent alert index requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    // Build the replacement first; a timeout rolls back and leaves the old index intact.
    await runner.query(`CREATE INDEX IF NOT EXISTS "IDX_notifications_urgent_outbox_v2" ON notifications ("createdAt", id)
      WHERE "eventKey" IS NOT NULL AND "isActive" = true AND status IN ('pending', 'failed')
      AND data ->> 'type' IN ('new_booking', 'driver_dispatch_offer', 'trip_request_nearby')`);
    await runner.query('DROP INDEX IF EXISTS "IDX_notifications_urgent_outbox"');
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Urgent alert index requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '5s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query(`CREATE INDEX IF NOT EXISTS "IDX_notifications_urgent_outbox" ON notifications ("createdAt", id)
      WHERE "eventKey" IS NOT NULL AND "isActive" = true AND status IN ('pending', 'failed')
      AND data ->> 'type' IN ('new_booking', 'driver_dispatch_offer')`);
    await runner.query('DROP INDEX IF EXISTS "IDX_notifications_urgent_outbox_v2"');
  }
}
