import { MigrationInterface, QueryRunner } from 'typeorm';

export class RememberDriverRequestRefusals1780000095000 implements MigrationInterface {
  name = 'RememberDriverRequestRefusals1780000095000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE trip_request_driver_refusals (
      "driverId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "requestId" uuid NOT NULL REFERENCES trip_requests(id) ON DELETE CASCADE,
      "declinedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("driverId", "requestId")
    )`);
    await runner.query('CREATE INDEX "IDX_request_refusal_request" ON trip_request_driver_refusals ("requestId")');
    await runner.query(`INSERT INTO trip_request_driver_refusals ("driverId", "requestId", "declinedAt")
      SELECT e."driverId", e."requestId", e."declinedAt" FROM nearby_driver_ring_events e
      JOIN trip_requests r ON r.id = e."requestId" JOIN users u ON u.id = e."driverId"
      WHERE e."declinedAt" IS NOT NULL AND r."passengerId" <> e."driverId"
      ON CONFLICT DO NOTHING`);
    await runner.query(`INSERT INTO trip_request_driver_refusals ("driverId", "requestId")
      SELECT o."driverId", o."requestId" FROM trip_request_dispatch_offers o
      JOIN trip_requests r ON r.id = o."requestId" JOIN users u ON u.id = o."driverId"
      WHERE o.status = 'declined' AND r."passengerId" <> o."driverId" ON CONFLICT DO NOTHING`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE trip_request_driver_refusals');
  }
}
