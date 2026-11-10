import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PartnerFieldWorkspace1780000117000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE partner_members ADD COLUMN zones jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`CREATE TABLE partner_field_daily_reports (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "organizationId" uuid NOT NULL REFERENCES partner_organizations(id) ON DELETE CASCADE,
      "agentId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "reportDate" date NOT NULL,
      "contactsCount" integer NOT NULL DEFAULT 0 CHECK ("contactsCount" >= 0),
      zone varchar(100),
      summary text NOT NULL,
      obstacles text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_partner_field_report_day" ON partner_field_daily_reports("organizationId", "agentId", "reportDate")`);
    await q.query(`CREATE INDEX "IDX_partner_field_report_team_date" ON partner_field_daily_reports("organizationId", "reportDate" DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE partner_field_daily_reports`);
    await q.query(`ALTER TABLE partner_members DROP COLUMN zones`);
  }
}
