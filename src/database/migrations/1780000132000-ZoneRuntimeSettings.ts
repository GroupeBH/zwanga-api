import { MigrationInterface, QueryRunner } from 'typeorm';

export class ZoneRuntimeSettings1780000132000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Zone settings require a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`CREATE TABLE zone_settings (
      id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1, "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO zone_settings(id) VALUES(true);
    CREATE TABLE zone_settings_audit (
      id uuid PRIMARY KEY, "actorId" uuid NOT NULL, enabled boolean NOT NULL,
      version integer NOT NULL UNIQUE, "createdAt" timestamptz NOT NULL DEFAULT now()
    );`);
  }
  async down(q: QueryRunner): Promise<void> {
    const [{ used }] = await q.query(
      'SELECT EXISTS(SELECT 1 FROM zone_settings_audit) AS used',
    );
    if (used) throw Error('Preserve zone settings audit before reverting.');
    await q.query('DROP TABLE zone_settings_audit,zone_settings');
  }
}
