import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDriverPublicationPhotoPolicy1780000044000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasPublishedTrip" boolean NOT NULL DEFAULT false`);
    // Includes cancelled/completed publications, but not private accepted requests.
    await queryRunner.query(`
      UPDATE "users" AS u SET "hasPublishedTrip" = true
      WHERE EXISTS (
        SELECT 1 FROM "trips" AS t WHERE t."driverId" = u.id AND t."isPrivate" = false
      )
    `);
  }

  public async down(): Promise<void> {
    throw new Error('La trace des publications doit être conservée ; retour arrière manuel requis.');
  }
}
