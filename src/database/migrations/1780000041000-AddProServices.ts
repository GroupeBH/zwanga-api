import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProServices1780000041000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE pro_service_offerings (
      code text PRIMARY KEY, name text NOT NULL, description text NOT NULL,
      availability text NOT NULL CHECK (availability IN ('open','coming_soon','paused')),
      terms jsonb, "updatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE pro_service_cases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid REFERENCES users(id) ON DELETE RESTRICT,
      "serviceCode" text NOT NULL REFERENCES pro_service_offerings(code), origin text NOT NULL CHECK (origin IN ('mobile','web')),
      "submissionKey" uuid NOT NULL UNIQUE, application jsonb NOT NULL,
      status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','reviewing','needs_info','quoted','accepted','processing','ready','completed','rejected','cancelled')),
      quote jsonb, "acceptedQuoteVersion" integer, "acceptedAt" timestamptz, "customerMessage" text NOT NULL DEFAULT '',
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(
      `CREATE INDEX pro_service_cases_owner_page ON pro_service_cases ("ownerId", "createdAt" DESC, id DESC)`,
    );
    await q.query(
      `CREATE INDEX pro_service_cases_status_page ON pro_service_cases (status, "createdAt" DESC, id DESC)`,
    );
    await q.query(
      `CREATE INDEX pro_service_cases_page ON pro_service_cases ("createdAt" DESC, id DESC)`,
    );
    await q.query(
      `CREATE INDEX pro_service_cases_service ON pro_service_cases ("serviceCode")`,
    );
    await q.query(`CREATE TABLE pro_service_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "caseId" uuid NOT NULL REFERENCES pro_service_cases(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('deposit','funding','repayment')),
      "amountMinor" integer NOT NULL CHECK ("amountMinor" > 0), currency text NOT NULL CHECK (currency IN ('CDF','USD')),
      reference text NOT NULL UNIQUE, evidence text NOT NULL, "recordedBy" uuid NOT NULL REFERENCES users(id),
      "createdAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(
      `CREATE INDEX pro_service_ledger_case ON pro_service_ledger ("caseId", "createdAt")`,
    );
    await q.query(
      `CREATE INDEX pro_service_ledger_actor ON pro_service_ledger ("recordedBy")`,
    );
    await q.query(`CREATE UNIQUE INDEX pro_service_ledger_one_advance ON pro_service_ledger ("caseId") WHERE kind = 'funding'`);
    await q.query(`CREATE TABLE pro_service_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "caseId" uuid NOT NULL REFERENCES pro_service_cases(id) ON DELETE RESTRICT,
      code text NOT NULL, label text NOT NULL, status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','held','release_ready','returned')),
      "storageLocation" text NOT NULL DEFAULT '', receipt text NOT NULL DEFAULT '', "returnReceipt" text NOT NULL DEFAULT '',
      "heldAt" timestamptz, "returnedAt" timestamptz, UNIQUE ("caseId", code))`);
    await q.query(`CREATE TABLE pro_service_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "caseId" uuid REFERENCES pro_service_cases(id) ON DELETE RESTRICT,
      "actorId" uuid REFERENCES users(id), action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
      "createdAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(
      `CREATE INDEX pro_service_events_case ON pro_service_events ("caseId", "createdAt")`,
    );
    await q.query(
      `CREATE INDEX pro_service_events_actor ON pro_service_events ("actorId")`,
    );
    // Snapshot the seed in the migration; future catalogue changes must not rewrite migration history.
    const seeds = [
      [
        'documents',
        'Documents et autorisations',
        'Confiez vos démarches à Zwanga. Devis après étude du dossier.',
        'open',
      ],
      [
        'vehicles',
        'Véhicules',
        'Accès à un véhicule et solutions de financement.',
        'coming_soon',
      ],
      [
        'equipment',
        'Équipements professionnels',
        'Équipements pour conducteurs et livreurs.',
        'coming_soon',
      ],
      [
        'fleet',
        'Gestion de flotte',
        'Accompagnement des propriétaires et gestionnaires de flotte.',
        'coming_soon',
      ],
    ];
    for (const values of seeds)
      await q.query(
        'INSERT INTO pro_service_offerings(code,name,description,availability) VALUES ($1,$2,$3,$4)',
        values,
      );
  }
  async down(): Promise<void> {
    throw new Error(
      'Rollback refused: preserve service dossiers, financial records and original-document custody.',
    );
  }
}
