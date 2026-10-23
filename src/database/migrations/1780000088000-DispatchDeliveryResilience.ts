import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive: no historical send is treated as a device receipt. */
export class DispatchDeliveryResilience1780000088000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, () => this.applyUp(runner));
  }

  private async applyUp(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE nearby_driver_ring_events ADD COLUMN "receivedAt" timestamptz`);
    await runner.query(`ALTER TABLE trip_requests ADD COLUMN "dispatchLeaseId" uuid,
      ADD COLUMN "dispatchClaimedUntil" timestamptz`);
    await runner.query(`CREATE TABLE ride_realtime_deliveries (
      "notificationId" uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
      "attemptedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "completedAt" timestamptz,
      attempts integer NOT NULL DEFAULT 1
    )`);
    await runner.query(`CREATE INDEX dispatch_ready_requests_idx
      ON trip_requests ("dispatchCheckedAt" NULLS FIRST, "createdAt", id)
      WHERE status IN ('pending','offers_received') AND "departurePoint" IS NOT NULL
        AND "selectedDriverId" IS NULL AND "tripId" IS NULL`);
    await runner.query(`CREATE INDEX ride_realtime_notifications_idx ON notifications ("createdAt", id)
      WHERE "eventKey" IS NOT NULL AND "isActive" = true
        AND data ->> 'type' IN ('driver_dispatch_offer','trip_request_nearby','new_booking')`);
    // EXPLAIN under 1,000 drivers exposed one full vehicle scan per candidate.
    await runner.query(`CREATE INDEX dispatch_active_vehicle_owner_idx
      ON vehicles ("ownerId", type, "updatedAt" DESC, id) WHERE "isActive" = true`);
    await runner.query(`CREATE INDEX dispatch_assigned_driver_idx
      ON trip_requests ("selectedDriverId", "departureDateMax") WHERE status = 'driver_selected'`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await this.withBudget(runner, async () => {
      await runner.query('DROP INDEX dispatch_assigned_driver_idx');
      await runner.query('DROP INDEX dispatch_active_vehicle_owner_idx');
      await runner.query('DROP INDEX ride_realtime_notifications_idx');
      await runner.query('DROP INDEX dispatch_ready_requests_idx');
      await runner.query('DROP TABLE ride_realtime_deliveries');
      await runner.query('ALTER TABLE trip_requests DROP COLUMN "dispatchLeaseId", DROP COLUMN "dispatchClaimedUntil"');
      await runner.query('ALTER TABLE nearby_driver_ring_events DROP COLUMN "receivedAt"');
    });
  }

  private async withBudget(runner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      const [previous] = await runner.query(`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`);
      await runner.query("SELECT set_config('lock_timeout', '3s', true), set_config('statement_timeout', '30s', true)");
      await work();
      await runner.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        [previous.lock_timeout, previous.statement_timeout]);
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }
}
