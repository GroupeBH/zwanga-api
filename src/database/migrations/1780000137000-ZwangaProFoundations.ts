import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive extension: no seed opens an offer or rewrites an existing debt. */
export class ZwangaProFoundations1780000137000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw Error('Zwanga Pro requires a transaction');
    await q.query("SET LOCAL lock_timeout='5s'");
    await q.query("SET LOCAL statement_timeout='30s'");
    await q.query(`
      CREATE TABLE pro_credit_parties (
        "organizationId" uuid PRIMARY KEY REFERENCES partner_organizations(id),
        supplier boolean NOT NULL, funder boolean NOT NULL, operator boolean NOT NULL,
        enabled boolean NOT NULL DEFAULT false, "authorizationReference" text NOT NULL,
        "validatedBy" uuid NOT NULL REFERENCES users(id), "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pro_party_validator ON pro_credit_parties("validatedBy");
      CREATE TABLE pro_credit_grants (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL REFERENCES users(id),
        role text NOT NULL CHECK(role IN ('manager','analyst','stock','documents','accountant','collector','funder','supplier','auditor')),
        "organizationId" uuid REFERENCES partner_organizations(id), enabled boolean NOT NULL DEFAULT true,
        "grantedBy" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE NULLS NOT DISTINCT ("userId",role,"organizationId"),
        CHECK ((role IN ('funder','supplier')) = ("organizationId" IS NOT NULL))
      );
      CREATE INDEX pro_grant_org ON pro_credit_grants("organizationId");
      CREATE INDEX pro_grant_actor ON pro_credit_grants("grantedBy");
      CREATE TABLE pro_credit_policies (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), version text NOT NULL UNIQUE,
        terms text NOT NULL, "legalReference" text NOT NULL, rules jsonb NOT NULL,
        "createdBy" uuid NOT NULL REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pro_policy_actor ON pro_credit_policies("createdBy");
      CREATE TABLE pro_credit_products (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), code text NOT NULL UNIQUE,
        kind text NOT NULL CHECK(kind IN ('document','phone','equipment')), name text NOT NULL, description text NOT NULL,
        enabled boolean NOT NULL DEFAULT false, currency text NOT NULL CHECK(currency='CDF'),
        "supplierId" uuid NOT NULL REFERENCES pro_credit_parties("organizationId"),
        "sellerId" uuid NOT NULL REFERENCES pro_credit_parties("organizationId"),
        "creditorId" uuid NOT NULL REFERENCES pro_credit_parties("organizationId"),
        "policyId" uuid NOT NULL REFERENCES pro_credit_policies(id),
        "financingModel" text NOT NULL CHECK("financingModel" IN ('ZWANGA_DIRECT','PARTNER_DIRECT','CO_FINANCED')),
        "priceMinor" bigint NOT NULL CHECK("priceMinor">0 AND "priceMinor"<=1000000000000 AND "priceMinor"%10=0),
        "feeMinor" bigint NOT NULL CHECK("feeMinor">=0 AND "feeMinor"<=1000000000000 AND "feeMinor"%10=0),
        details jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pro_product_supplier ON pro_credit_products("supplierId");
      CREATE INDEX pro_product_seller ON pro_credit_products("sellerId");
      CREATE INDEX pro_product_creditor ON pro_credit_products("creditorId");
      CREATE INDEX pro_product_policy ON pro_credit_products("policyId");
      CREATE TABLE pro_credit_attachments (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "ownerId" uuid NOT NULL REFERENCES users(id),
        "storageKey" text NOT NULL UNIQUE, "sha256" text NOT NULL, "mimeType" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pro_attachment_owner ON pro_credit_attachments("ownerId");
      ALTER TABLE asset_credit_requests ADD COLUMN "proProductId" uuid REFERENCES pro_credit_products(id),
        ADD COLUMN "proApplication" jsonb, ADD COLUMN "proMutationId" uuid UNIQUE;
      CREATE INDEX pro_request_product ON asset_credit_requests("proProductId");
      ALTER TABLE asset_credits DROP CONSTRAINT "CHK_asset_credit_rate";
      ALTER TABLE asset_credits ADD CONSTRAINT "CHK_asset_credit_rate" CHECK(
        "repaymentBps" BETWEEN 1 AND 9500 AND "policyVersion" IN ('asset-credit-v1','asset-credit-v2','zwanga-pro-v1')
        AND ("policyVersion"<>'asset-credit-v1' OR "repaymentBps"=500));
      CREATE TABLE pro_credit_contracts (
        "creditId" uuid PRIMARY KEY REFERENCES asset_credits(id), "requestId" uuid NOT NULL UNIQUE REFERENCES asset_credit_requests(id),
        "productId" uuid NOT NULL REFERENCES pro_credit_products(id), "creditorId" uuid NOT NULL REFERENCES pro_credit_parties("organizationId"),
        "vehicleId" uuid REFERENCES vehicles(id), "caseId" uuid REFERENCES pro_service_cases(id),
        snapshot jsonb NOT NULL, "termsHash" text NOT NULL, evaluation jsonb NOT NULL,
        "depositMinor" bigint NOT NULL CHECK("depositMinor">=0 AND "depositMinor"%10=0),
        "depositPaidMinor" bigint NOT NULL DEFAULT 0 CHECK("depositPaidMinor">=0 AND "depositPaidMinor"<="depositMinor"),
        "mandateUntil" timestamptz, "mandateRevokedAt" timestamptz, "consentMutationId" uuid UNIQUE,
        "deliveryState" text NOT NULL DEFAULT 'pending' CHECK("deliveryState" IN ('pending','processing','delivered','rejected','returned')),
        "deliveryProofId" uuid REFERENCES pro_credit_attachments(id), "deliveredAt" timestamptz,
        "scheduleVersion" integer NOT NULL DEFAULT 1, "scheduleBaselineMinor" bigint NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pro_contract_product ON pro_credit_contracts("productId");
      CREATE INDEX pro_contract_creditor ON pro_credit_contracts("creditorId");
      CREATE INDEX pro_contract_vehicle ON pro_credit_contracts("vehicleId");
      CREATE INDEX pro_contract_case ON pro_credit_contracts("caseId");
      CREATE INDEX pro_contract_proof ON pro_credit_contracts("deliveryProofId");
      CREATE TABLE pro_credit_stock (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "productId" uuid NOT NULL REFERENCES pro_credit_products(id),
        "inventoryReference" text NOT NULL UNIQUE, "serialHash" text NOT NULL UNIQUE, "imeiHash" text UNIQUE,
        "encryptedIdentity" text NOT NULL, "creditId" uuid UNIQUE REFERENCES asset_credits(id),
        status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','assigned','delivered','returned','quarantined')),
        "createdAt" timestamptz NOT NULL DEFAULT now(), CHECK((status='available') = ("creditId" IS NULL) OR status='quarantined')
      );
      CREATE INDEX pro_stock_available ON pro_credit_stock("productId",id) WHERE status='available';
      CREATE TABLE pro_credit_installments (
        "creditId" uuid NOT NULL REFERENCES asset_credits(id), version integer NOT NULL CHECK(version>0),
        ordinal integer NOT NULL CHECK(ordinal>0), "dueAt" timestamptz NOT NULL,
        "amountMinor" bigint NOT NULL CHECK("amountMinor">0 AND "amountMinor"%10=0),
        PRIMARY KEY("creditId",version,ordinal)
      );
      CREATE INDEX pro_installments_due ON pro_credit_installments("dueAt","creditId");
      CREATE TABLE pro_credit_journals (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "creditId" uuid NOT NULL REFERENCES asset_credits(id),
        "creditorId" uuid NOT NULL REFERENCES pro_credit_parties("organizationId"), currency text NOT NULL CHECK(currency='CDF'),
        "sourceKey" text NOT NULL UNIQUE, "debitAccount" text NOT NULL, "creditAccount" text NOT NULL,
        "amountMinor" bigint NOT NULL CHECK("amountMinor">0 AND "amountMinor"%10=0),
        "reversesId" uuid UNIQUE REFERENCES pro_credit_journals(id), detail jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(), CHECK("debitAccount"<>"creditAccount")
      );
      CREATE INDEX pro_journal_credit ON pro_credit_journals("creditId",id);
      CREATE INDEX pro_journal_creditor ON pro_credit_journals("creditorId",id);
      CREATE VIEW pro_credit_ledger_lines AS
        SELECT id AS "journalId","creditId","creditorId",currency,"debitAccount" AS account,"amountMinor" AS debit,0::bigint AS credit FROM pro_credit_journals
        UNION ALL SELECT id,"creditId","creditorId",currency,"creditAccount",0::bigint,"amountMinor" FROM pro_credit_journals;
      CREATE TABLE pro_credit_mutations (
        id uuid PRIMARY KEY, "actorId" uuid NOT NULL REFERENCES users(id), action text NOT NULL,
        payload jsonb NOT NULL, result jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pro_mutation_actor ON pro_credit_mutations("actorId");
      CREATE TABLE pro_credit_audit (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "actorId" uuid REFERENCES users(id), "creditId" uuid REFERENCES asset_credits(id),
        action text NOT NULL, detail jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX pro_audit_credit ON pro_credit_audit("creditId",id);
      CREATE INDEX pro_audit_actor ON pro_credit_audit("actorId");
      CREATE TABLE pro_credit_documents (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "creditId" uuid NOT NULL UNIQUE REFERENCES asset_credits(id),
        "vehicleId" uuid NOT NULL REFERENCES vehicles(id), "proofId" uuid NOT NULL REFERENCES pro_credit_attachments(id),
        "issuedAt" timestamptz NOT NULL, "expiresAt" timestamptz, CHECK("expiresAt" IS NULL OR "expiresAt">"issuedAt")
      );
      CREATE INDEX pro_document_vehicle ON pro_credit_documents("vehicleId");
      CREATE INDEX pro_document_proof ON pro_credit_documents("proofId");
      CREATE INDEX pro_document_expiry ON pro_credit_documents("expiresAt");
      CREATE FUNCTION zwanga_pro_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'ZWANGA_PRO_IMMUTABLE'; END $$;
      CREATE TRIGGER pro_policy_immutable BEFORE UPDATE OR DELETE ON pro_credit_policies FOR EACH ROW EXECUTE FUNCTION zwanga_pro_immutable();
      CREATE TRIGGER pro_journal_immutable BEFORE UPDATE OR DELETE ON pro_credit_journals FOR EACH ROW EXECUTE FUNCTION zwanga_pro_immutable();
      CREATE TRIGGER pro_audit_immutable BEFORE UPDATE OR DELETE ON pro_credit_audit FOR EACH ROW EXECUTE FUNCTION zwanga_pro_immutable();
      CREATE TRIGGER pro_schedule_immutable BEFORE UPDATE OR DELETE ON pro_credit_installments FOR EACH ROW EXECUTE FUNCTION zwanga_pro_immutable();
      CREATE TRIGGER pro_mutation_immutable BEFORE UPDATE OR DELETE ON pro_credit_mutations FOR EACH ROW EXECUTE FUNCTION zwanga_pro_immutable();
      CREATE FUNCTION zwanga_pro_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ROW(NEW.snapshot,NEW."termsHash",NEW.evaluation,NEW."creditorId",NEW."depositMinor",NEW."requestId",NEW."productId",NEW."vehicleId",NEW."caseId")
          IS DISTINCT FROM ROW(OLD.snapshot,OLD."termsHash",OLD.evaluation,OLD."creditorId",OLD."depositMinor",OLD."requestId",OLD."productId",OLD."vehicleId",OLD."caseId")
          THEN RAISE EXCEPTION 'ZWANGA_PRO_IMMUTABLE'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER pro_contract_immutable BEFORE UPDATE ON pro_credit_contracts FOR EACH ROW EXECUTE FUNCTION zwanga_pro_contract_immutable();
    `);
  }
  down(): Promise<void> {
    throw Error(
      'Preserve contracts and financial evidence. Disable new products and use a forward migration.',
    );
  }
}
