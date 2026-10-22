import type { MigrationInterface, QueryRunner } from 'typeorm';

export class NearbyRequestRingingCooldown1780000087000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE nearby_driver_ring_state (
      "driverId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      "missedCount" smallint NOT NULL DEFAULT 0 CHECK ("missedCount" BETWEEN 0 AND 4),
      "mutedUntil" timestamptz,
      "cycleStartedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE TABLE nearby_driver_ring_events (
      "driverId" uuid NOT NULL REFERENCES nearby_driver_ring_state("driverId") ON DELETE CASCADE,
      "requestId" uuid NOT NULL REFERENCES trip_requests(id) ON DELETE CASCADE,
      "notificationId" uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "responseDeadline" timestamptz NOT NULL,
      "declinedAt" timestamptz,
      "processedAt" timestamptz,
      outcome text CHECK (outcome IN ('declined', 'ignored', 'answered', 'obsolete', 'muted')),
      PRIMARY KEY ("driverId", "requestId")
    )`);
    await runner.query(`CREATE INDEX nearby_ring_due_idx ON nearby_driver_ring_events
      ("responseDeadline", "driverId") WHERE "processedAt" IS NULL`);
    await runner.query(
      `CREATE INDEX nearby_ring_notification_idx ON nearby_driver_ring_events ("notificationId")`,
    );
    await runner.query(
      `CREATE INDEX nearby_ring_request_idx ON nearby_driver_ring_events ("requestId")`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE nearby_driver_ring_events');
    await runner.query('DROP TABLE nearby_driver_ring_state');
  }
}
