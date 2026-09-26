import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExplicitDriverActivation1780000043000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // No backfill: vehicle ownership and legacy flags cannot prove consent.
    await q.query(`ALTER TABLE users
      ADD COLUMN "driverOnboardingRequestedAt" timestamptz,
      ADD COLUMN "driverActivatedAt" timestamptz`);
  }

  async down(): Promise<void> {
    throw new Error('Conserver les preuves d’activation conducteur ; effectuer un retour applicatif sans supprimer ces colonnes.');
  }
}
