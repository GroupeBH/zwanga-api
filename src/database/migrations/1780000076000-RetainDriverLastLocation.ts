import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RetainDriverLastLocation1780000076000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // NULL preserves legacy leases: their expiry cannot distinguish an explicit
    // opt-out from elapsed time. Only a subsequent GPS/availability update opts in.
    // No backfill, table rewrite or change to existing coordinates/leases.
    await runner.query('ALTER TABLE driver_dispatch_presence ADD COLUMN "discoveryEnabled" boolean');
  }

  async down(runner: QueryRunner): Promise<void> {
    // Coordinates remain intact; older code resumes its original lease policy.
    await runner.query('ALTER TABLE driver_dispatch_presence DROP COLUMN "discoveryEnabled"');
  }
}
