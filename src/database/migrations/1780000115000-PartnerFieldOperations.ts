import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PartnerFieldOperations1780000115000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE partner_organizations (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "displayName" varchar(160) NOT NULL,
      "legalName" varchar(200),
      "legalType" varchar(30) NOT NULL CHECK ("legalType" IN ('COMPANY','ASSOCIATION','CHURCH','INDIVIDUAL')),
      status varchar(30) NOT NULL DEFAULT 'PROSPECT' CHECK (status IN ('PROSPECT','IN_REVIEW','DOCUMENTS_REQUIRED','APPROVED','CONTRACTING','ACTIVE','REJECTED','SUSPENDED','CLOSED')),
      "partnerTypes" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE INDEX "IDX_partner_organization_status" ON partner_organizations(status);

      CREATE TABLE partner_members (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES partner_organizations(id) ON DELETE CASCADE,
        "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role varchar(30) NOT NULL CHECK (role IN ('ORG_ADMIN','FIELD_SUPERVISOR','FIELD_AGENT')),
        status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INVITED','SUSPENDED','REMOVED')),
        "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_partner_member_org_user" ON partner_members("organizationId","userId");
      CREATE INDEX "IDX_partner_member_user" ON partner_members("userId");

      CREATE TABLE partner_field_leads (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES partner_organizations(id) ON DELETE CASCADE,
        "agentId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "firstName" varchar(80) NOT NULL,
        "lastName" varchar(80) NOT NULL,
        phone varchar(15) NOT NULL,
        city varchar(100) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_partner_field_lead_phone" ON partner_field_leads("organizationId",phone);
      CREATE INDEX "IDX_partner_field_lead_agent_created" ON partner_field_leads("agentId","createdAt");

      CREATE TABLE partner_field_targets (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES partner_organizations(id) ON DELETE CASCADE,
        "agentId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period varchar(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        goal integer NOT NULL CHECK (goal > 0),
        "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_partner_field_target" ON partner_field_targets("organizationId","agentId",period);
      CREATE INDEX "IDX_partner_field_target_agent" ON partner_field_targets("agentId");

      CREATE TABLE partner_field_tickets (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES partner_organizations(id) ON DELETE CASCADE,
        "authorId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "supportTicketId" uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        "leadId" uuid REFERENCES partner_field_leads(id) ON DELETE SET NULL,
        category varchar(20) NOT NULL CHECK (category IN ('DRIVER','TECHNICAL','SAFETY','OTHER')),
        message text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX "UQ_partner_field_ticket_support" ON partner_field_tickets("supportTicketId");
      CREATE INDEX "IDX_partner_field_ticket_org_author" ON partner_field_tickets("organizationId","authorId");
      CREATE INDEX "IDX_partner_field_ticket_lead" ON partner_field_tickets("leadId") WHERE "leadId" IS NOT NULL;`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE partner_field_tickets; DROP TABLE partner_field_targets; DROP TABLE partner_field_leads; DROP TABLE partner_members; DROP TABLE partner_organizations;`);
  }
}
