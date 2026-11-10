import { randomUUID } from 'crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { SupportService } from '../support/support.service';
import { SupportTicket } from '../support/entities/support-ticket.entity';
import { SupportTicketMessage } from '../support/entities/support-ticket-message.entity';
import { PartnersService } from './partners.service';
import { PartnerFieldTicket } from './partner.entities';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('support/field ticket atomicity on isolated PostgreSQL', () => {
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource;
  let support: SupportService, partners: PartnersService;
  const user = randomUUID(), organization = randomUUID();
  beforeAll(async () => {
    db = await cluster.start(); await db.destroy();
    const id = { type: 'uuid' as const, primary: true, generated: 'uuid' as const };
    db.setOptions({ entities: [
      new EntitySchema({ name: 'SupportTicket', target: SupportTicket, tableName: 'support_tickets', columns: {
        id, userId: { type: 'uuid' }, subject: { type: 'text' }, category: { type: 'text' }, priority: { type: 'text' }, status: { type: 'text' }, lastMessageAt: { type: 'timestamptz' },
      } }),
      new EntitySchema({ name: 'SupportTicketMessage', target: SupportTicketMessage, tableName: 'support_ticket_messages', columns: {
        id, ticketId: { type: 'uuid' }, senderId: { type: 'uuid' }, content: { type: 'text' }, isInternal: { type: 'boolean' },
      } }),
      new EntitySchema({ name: 'PartnerFieldTicket', target: PartnerFieldTicket, tableName: 'partner_field_tickets', columns: {
        id, organizationId: { type: 'uuid' }, authorId: { type: 'uuid' }, supportTicketId: { type: 'uuid' }, leadId: { type: 'uuid', nullable: true }, category: { type: 'text' }, message: { type: 'text' }, createdAt: { type: 'timestamptz', createDate: true },
      } }),
    ] });
    await db.initialize();
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await db.synchronize(); // Disposable cluster only; never application configuration.
    support = Object.assign(Object.create(SupportService.prototype), { ticketRepository: db.getRepository(SupportTicket) });
    partners = Object.assign(Object.create(PartnersService.prototype), {
      tickets: db.getRepository(PartnerFieldTicket), support,
      fieldMember: async () => ({ role: 'FIELD_AGENT' }),
    });
  }, 120000);
  afterAll(() => cluster.stop(), 40000);
  beforeEach(() => db.query('TRUNCATE partner_field_tickets, support_ticket_messages, support_tickets'));
  const payload = { subject: 'Ticket de test', message: 'Message synthétique de test', category: 'TECHNICAL' };
  async function counts() {
    return Promise.all(['support_tickets', 'support_ticket_messages', 'partner_field_tickets'].map(async table => Number((await db.query(`SELECT count(*) AS n FROM ${table}`))[0].n)));
  }
  it('commits the support ticket, first message and field link together', async () => {
    const result = await partners.createTicket(user, organization, payload);
    expect(result).toMatchObject({ subject: payload.subject, status: 'OPEN', authorId: user });
    expect(await counts()).toEqual([1, 1, 1]);
  });
  it('rolls back both support rows if the field link cannot be saved', async () => {
    await db.query(`ALTER TABLE partner_field_tickets ADD CONSTRAINT fail_link CHECK (category <> 'TECHNICAL')`);
    try {
      await expect(partners.createTicket(user, organization, payload)).rejects.toMatchObject({ code: '23514' });
      expect(await counts()).toEqual([0, 0, 0]);
    } finally { await db.query('ALTER TABLE partner_field_tickets DROP CONSTRAINT fail_link'); }
  });
  it('rolls back the support ticket if its first message cannot be saved', async () => {
    await db.query('ALTER TABLE support_ticket_messages ADD CONSTRAINT fail_message CHECK ("isInternal" = true)');
    try {
      await expect(partners.createTicket(user, organization, payload)).rejects.toMatchObject({ code: '23514' });
      expect(await counts()).toEqual([0, 0, 0]);
      await expect(support.createTicket(user, { ...payload, priority: 'medium', category: 'other' } as any)).rejects.toMatchObject({ code: '23514' });
      expect(await counts()).toEqual([0, 0, 0]);
    } finally { await db.query('ALTER TABLE support_ticket_messages DROP CONSTRAINT fail_message'); }
  });

  it('executes the lean progress query with multiple KYC records and vehicles', async () => {
    await db.query(`CREATE TABLE users(id uuid PRIMARY KEY,phone varchar,role varchar,status varchar,"isActive" boolean,"driverOnboardingRequestedAt" timestamp);
      CREATE TABLE kyc_documents(id uuid PRIMARY KEY,"userId" uuid,"createdAt" timestamp,provider varchar,status varchar,"diditSessionStatus" varchar);
      CREATE TABLE vehicles(id uuid PRIMARY KEY,"ownerId" uuid,"isActive" boolean)`);
    const driver = randomUUID();
    await db.query(`INSERT INTO users VALUES ($1,'+243812345678','driver','active',true,NULL)`, [driver]);
    await db.query(`INSERT INTO kyc_documents VALUES
      (gen_random_uuid(),$1,'2026-10-01','didit','rejected',NULL),
      (gen_random_uuid(),$1,'2026-11-01','didit','approved',NULL)`, [driver]);
    await db.query('INSERT INTO vehicles VALUES (gen_random_uuid(),$1,true),(gen_random_uuid(),$1,true)', [driver]);
    const qb: any = { select: () => qb, addSelect: () => qb, where: () => qb, andWhere: () => qb, groupBy: () => qb, getRawMany: async () => [] };
    const service: any = Object.assign(Object.create(PartnersService.prototype), { users: { query: db.query.bind(db) }, trips: { createQueryBuilder: () => qb } });
    const result = await service.leadProgress([{ id: 'lead', phone: '+243812345678' }]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('READY_TO_DRIVE');
    expect(result[0]).not.toHaveProperty('kycDocuments');
  });
});
