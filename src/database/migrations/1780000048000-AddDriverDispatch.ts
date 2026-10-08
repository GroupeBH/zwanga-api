import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDriverDispatch1780000048000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE driver_notification_clients (
      "userId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      "tokenHash" varchar(64) NOT NULL
    )`);
    await runner.query(`ALTER TABLE trip_requests ADD COLUMN "immediateDispatch" boolean NOT NULL DEFAULT false`);
    await runner.query(`ALTER TABLE trip_requests ADD COLUMN IF NOT EXISTS "dispatchCheckedAt" timestamptz`);
    await runner.query(`CREATE TABLE driver_dispatch_presence (
      "driverId" uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      "vehicleId" uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      "leaseId" uuid NOT NULL,
      seats integer NOT NULL CHECK (seats BETWEEN 1 AND 20),
      position geography(Point,4326) NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE INDEX dispatch_presence_position_idx ON driver_dispatch_presence USING gist(position)`);
    await runner.query(`CREATE INDEX dispatch_presence_vehicle_idx ON driver_dispatch_presence("vehicleId")`);
    await runner.query(`CREATE INDEX dispatch_presence_expiry_idx ON driver_dispatch_presence("expiresAt")`);
    await runner.query(`CREATE TABLE trip_request_dispatch_offers (
      id uuid PRIMARY KEY,
      "requestId" uuid NOT NULL REFERENCES trip_requests(id) ON DELETE CASCADE,
      "driverId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "vehicleId" uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      seats integer NOT NULL CHECK (seats BETWEEN 1 AND 20),
      status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE ("requestId", "driverId")
    )`);
    await runner.query(`CREATE UNIQUE INDEX dispatch_one_pending_request_idx ON trip_request_dispatch_offers("requestId") WHERE status = 'pending'`);
    await runner.query(`CREATE UNIQUE INDEX dispatch_one_pending_driver_idx ON trip_request_dispatch_offers("driverId") WHERE status = 'pending'`);
    await runner.query(`CREATE INDEX dispatch_deadline_idx ON trip_request_dispatch_offers("expiresAt") WHERE status = 'pending'`);
    await runner.query(`CREATE INDEX dispatch_offers_driver_idx ON trip_request_dispatch_offers("driverId")`);
    await runner.query(`CREATE INDEX dispatch_offers_vehicle_idx ON trip_request_dispatch_offers("vehicleId")`);
    await runner.query(`CREATE INDEX dispatch_waiting_requests_idx ON trip_requests("dispatchCheckedAt" NULLS FIRST, "createdAt") WHERE "immediateDispatch" = true AND status = 'pending'`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE IF EXISTS driver_notification_clients`);
    await runner.query(`DROP INDEX IF EXISTS dispatch_waiting_requests_idx`);
    await runner.query(`DROP TABLE IF EXISTS trip_request_dispatch_offers`);
    await runner.query(`DROP TABLE IF EXISTS driver_dispatch_presence`);
    await runner.query(`ALTER TABLE trip_requests DROP COLUMN "immediateDispatch"`);
    await runner.query(`ALTER TABLE trip_requests DROP COLUMN "dispatchCheckedAt"`);
  }
}
