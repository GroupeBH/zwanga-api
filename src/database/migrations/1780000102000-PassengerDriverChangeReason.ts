import { MigrationInterface, QueryRunner } from 'typeorm';

/** Reuse the existing request-scoped exclusion list without recording a driver refusal. */
export class PassengerDriverChangeReason1780000102000 implements MigrationInterface {
  name = 'PassengerDriverChangeReason1780000102000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE trip_request_driver_refusals
      ADD COLUMN reason varchar(40) NOT NULL DEFAULT 'driver_declined'`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Keep exclusions even on rollback; only the new attribution is removed.
    await runner.query(
      'ALTER TABLE trip_request_driver_refusals DROP COLUMN reason',
    );
  }
}
