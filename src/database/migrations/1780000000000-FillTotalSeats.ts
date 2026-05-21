import { MigrationInterface, QueryRunner } from 'typeorm';

export class FillTotalSeats1780000000000 implements MigrationInterface {
  name = 'FillTotalSeats1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'trips'
            AND column_name = 'totalSeats'
        ) THEN
          UPDATE trips
          SET "totalSeats" = "availableSeats"
          WHERE "totalSeats" IS NULL;
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Data backfill is intentionally not reverted.
  }
}
