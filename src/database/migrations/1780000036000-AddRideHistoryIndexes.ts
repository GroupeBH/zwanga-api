import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRideHistoryIndexes1780000036000 implements MigrationInterface {
  name = 'AddRideHistoryIndexes1780000036000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_trips_driver_history" ON trips ("driverId", "departureDate" DESC, id DESC)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS "IDX_bookings_passenger_history" ON bookings ("passengerId", "tripId", id)');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_bookings_passenger_history"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_trips_driver_history"');
  }
}
