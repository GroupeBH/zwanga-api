import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive index: older workers keep their v2 index during a staged rollout.
 * Never replay historic notifications or change existing ride decisions. */
export class RideResponseOutbox1780000084000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Ride response migration requires a transaction');
    await runner.query("SET LOCAL lock_timeout = '3s'");
    await runner.query("SET LOCAL statement_timeout = '30s'");
    await runner.query(`CREATE INDEX "IDX_notifications_urgent_outbox_v3" ON notifications ("createdAt", id)
      WHERE "eventKey" IS NOT NULL AND "isActive" = true AND status IN ('pending', 'failed')
        AND data ->> 'type' IN ('new_booking', 'driver_dispatch_offer', 'trip_request_nearby', 'booking_response', 'trip_request_accepted')`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX IF EXISTS "IDX_notifications_urgent_outbox_v3"');
  }
}
