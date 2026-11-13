import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { PartnerFieldOperations1780000115000 } from '../database/migrations/1780000115000-PartnerFieldOperations';
import { PartnerCompanyManagers1780000121000 } from '../database/migrations/1780000121000-PartnerCompanyManagers';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('company manager role migration on isolated PostgreSQL', () => {
  const cluster = new IsolatedPostgres(bin!);
  const migration = new PartnerCompanyManagers1780000121000();
  let db: DataSource;
  const organization = randomUUID();
  const withUser = async (role: string) => {
    const user = randomUUID();
    await db.query('INSERT INTO users (id) VALUES ($1)', [user]);
    await db.query('INSERT INTO partner_members ("organizationId","userId",role) VALUES ($1,$2,$3)', [organization, user, role]);
  };
  const run = async (step: 'up' | 'down') => {
    const runner = db.createQueryRunner();
    try { await migration[step](runner); } finally { await runner.release(); }
  };

  beforeAll(async () => {
    db = await cluster.start();
    await db.query('CREATE EXTENSION "uuid-ossp"');
    await db.query('CREATE TABLE users (id uuid PRIMARY KEY); CREATE TABLE support_tickets (id uuid PRIMARY KEY)');
    const runner = db.createQueryRunner();
    try { await new PartnerFieldOperations1780000115000().up(runner); } finally { await runner.release(); }
    await db.query(`INSERT INTO partner_organizations (id,"displayName","legalType",status) VALUES ($1,'Transco','COMPANY','ACTIVE')`, [organization]);
  }, 120000);
  afterAll(() => cluster.stop(), 60000);

  it('accepts managers after the migration and still refuses unknown roles', async () => {
    await expect(withUser('ORG_MANAGER')).rejects.toThrow(/partner_members_role_check/);
    await run('up');
    await expect(withUser('ORG_MANAGER')).resolves.toBeUndefined();
    await expect(withUser('ORG_ADMIN')).resolves.toBeUndefined();
    await expect(withUser('FIELD_AGENT')).resolves.toBeUndefined();
    await expect(withUser('OWNER')).rejects.toThrow(/partner_members_role_check/);
  });

  it('refuses to roll back while managers exist, then restores the original rule', async () => {
    await expect(run('down')).rejects.toThrow(/ORG_MANAGER existent/);
    await db.query(`DELETE FROM partner_members WHERE role = 'ORG_MANAGER'`);
    await run('down');
    await expect(withUser('ORG_MANAGER')).rejects.toThrow(/partner_members_role_check/);
    await expect(withUser('FIELD_SUPERVISOR')).resolves.toBeUndefined();
  });
});
