import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entreprises créées par Zwanga : un gestionnaire (ORG_MANAGER) peut être rattaché
 * à côté du responsable (ORG_ADMIN). Seule la contrainte du rôle change.
 */
export class PartnerCompanyManagers1780000121000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Nom attribué par PostgreSQL à la contrainte de colonne de 1780000115000 :
    // un nom différent fait échouer la migration au lieu de laisser l'ancienne règle active.
    await q.query(`ALTER TABLE partner_members DROP CONSTRAINT partner_members_role_check`);
    await q.query(`ALTER TABLE partner_members ADD CONSTRAINT partner_members_role_check
      CHECK (role IN ('ORG_ADMIN','ORG_MANAGER','FIELD_SUPERVISOR','FIELD_AGENT'))`);
  }

  async down(q: QueryRunner): Promise<void> {
    const [{ count }]: { count: number }[] = await q.query(`SELECT count(*)::int AS count FROM partner_members WHERE role = 'ORG_MANAGER'`);
    if (count > 0) {
      throw new Error(`${count} rattachement(s) ORG_MANAGER existent : changez leur rôle ou supprimez-les avant d'annuler cette migration.`);
    }
    await q.query(`ALTER TABLE partner_members DROP CONSTRAINT partner_members_role_check`);
    await q.query(`ALTER TABLE partner_members ADD CONSTRAINT partner_members_role_check
      CHECK (role IN ('ORG_ADMIN','FIELD_SUPERVISOR','FIELD_AGENT'))`);
  }
}
