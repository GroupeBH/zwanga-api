import { randomUUID } from 'crypto';
import { ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { User } from '../users/entities/user.entity';
import { AddProServices1780000041000 } from '../database/migrations/1780000041000-AddProServices';
import { PRO_SERVICE_ENTITIES, ProServiceCase, ProServiceEvent } from './pro-service.entities';
import { ProServiceStore } from './pro-service.store';
import { ProServiceWorkflow } from './pro-service.workflow';
import { UpdateDocumentCaseDto } from './pro-service.dto';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)('one persistent document dossier per account on isolated PostgreSQL', () => {
  const cluster = new IsolatedPostgres(bin!);
  let db: DataSource, store: ProServiceStore, workflow: ProServiceWorkflow;
  const owner = randomUUID(), other = randomUUID();
  const application = { fullName: 'Test applicant', phone: '+0000000000', vehicleDescription: '', plate: '', documents: ['carte-rose'], description: '' };
  const payload = () => ({ serviceCode: 'documents' as const, submissionKey: randomUUID(), contactConsent: true, application });
  beforeAll(async () => {
    db = await cluster.start(); await db.destroy();
    db.setOptions({ entities: [...PRO_SERVICE_ENTITIES, new EntitySchema({ name: 'User', target: User, tableName: 'users', columns: {
      id: { type: 'uuid', primary: true }, isActive: { type: 'boolean' }, status: { type: 'text' }, isPhoneVerified: { type: 'boolean' },
    } })] });
    await db.initialize();
    await db.query('CREATE TABLE users (id uuid PRIMARY KEY, "isActive" boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT \'active\', "isPhoneVerified" boolean NOT NULL DEFAULT true)');
    const runner = db.createQueryRunner();
    try { await new AddProServices1780000041000().up(runner); } finally { await runner.release(); }
    store = new ProServiceStore(db); workflow = new ProServiceWorkflow(store);
  }, 120000);
  afterAll(() => cluster.stop(), 40000);
  beforeEach(async () => {
    await db.query('TRUNCATE pro_service_events, pro_service_documents, pro_service_ledger, pro_service_cases, users');
    await db.query('INSERT INTO users(id) VALUES($1),($2)', [owner, other]);
  }, 30000);
  const find = (id: string) => db.getRepository(ProServiceCase).findOneByOrFail({ id });
  const edit = (item: ProServiceCase, overrides: Partial<UpdateDocumentCaseDto> = {}) => ({
    mutationId: randomUUID(), expectedUpdatedAt: item.updatedAt.toISOString(), contactConsent: true,
    application: { ...application, documents: ['carte-rose', 'assurance-auto'] }, ...overrides,
  });
  it('serializes concurrent different submission keys across instances, keeping one dossier', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => new ProServiceStore(db).create(payload(), owner)));
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    for (const result of results.filter(value => value.status === 'rejected') as PromiseRejectedResult[])
      expect(result.reason.getResponse()).toMatchObject({ code: 'DOCUMENT_REQUEST_ALREADY_EXISTS' });
    expect(await db.getRepository(ProServiceCase).count()).toBe(1);
    expect(await db.getRepository(ProServiceEvent).count()).toBe(1);
  });
  it('replays simultaneous identical submissions and keeps other accounts independent', async () => {
    const dto = payload();
    const replies = await Promise.allSettled([store.create(dto, owner), store.create(dto, owner)]);
    expect(replies[0]).toEqual(replies[1]); expect(replies[0].status).toBe('fulfilled');
    await store.create(payload(), other);
    expect(await db.getRepository(ProServiceCase).count()).toBe(2);
  });
  it.each(['submitted', 'reviewing', 'needs_info', 'quoted', 'accepted', 'processing', 'ready', 'completed', 'rejected', 'cancelled'] as const)(
    'never creates a second dossier after status %s', async status => {
      const { id } = await store.create(payload(), owner);
      await db.getRepository(ProServiceCase).update(id, { status });
      await expect(store.create(payload(), owner)).rejects.toBeInstanceOf(ConflictException);
      expect(await store.currentDocumentCase(owner)).toEqual({ request: { id, status, canEdit: true } });
      expect(await store.currentDocumentCase(other)).toEqual({ request: null });
    },
  );
  it.each(['rejected', 'cancelled', 'needs_info', 'quoted'] as const)('updates the same %s dossier and invalidates old acceptance without losing quote history', async status => {
    const { id } = await store.create(payload(), owner);
    await db.getRepository(ProServiceCase).update(id, { status, quote: { version: 3 } as any });
    const item = await find(id); const dto = edit(item);
    await store.updateDocumentCase(id, owner, dto);
    const updated = await find(id);
    expect(updated).toMatchObject({ id, status: 'submitted', quote: { version: 3 }, acceptedAt: null,
      application: { ...dto.application, documents: ['assurance-auto', 'carte-rose'] } });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(item.updatedAt.getTime());
    await expect(workflow.accept(id, owner, { quoteVersion: 3, consent: true })).rejects.toThrow('changé ou a expiré');
    expect(await db.getRepository(ProServiceCase).count()).toBe(1);
  });
  it('replays an edit receipt after loss of response without overwriting subsequent edits', async () => {
    const { id } = await store.create(payload(), owner); const dto = edit(await find(id));
    await store.updateDocumentCase(id, owner, dto);
    const second = edit(await find(id), { application: { ...dto.application, description: 'Newer draft' } });
    await store.updateDocumentCase(id, owner, second);
    await expect(store.updateDocumentCase(id, owner, dto)).resolves.toEqual({ id });
    expect((await find(id)).application.description).toBe('Newer draft');
    expect(await db.getRepository(ProServiceEvent).countBy({ action: 'application_updated' })).toBe(2);
    await expect(store.updateDocumentCase(id, owner, { ...dto, application })).rejects.toThrow('déjà été utilisée');
  });
  it('prevents concurrent editors from overwriting each other', async () => {
    const { id } = await store.create(payload(), owner); const item = await find(id);
    const result = await Promise.allSettled([
      store.updateDocumentCase(id, owner, edit(item)),
      store.updateDocumentCase(id, owner, edit(item, { application: { ...application, description: 'Another draft' } })),
    ]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const failure = result.find(value => value.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason.getResponse()).toMatchObject({ code: 'DOCUMENT_REQUEST_CHANGED' });
  });
  it.each(['accepted', 'processing', 'ready', 'completed'] as const)('only adds documents in %s without changing contract, money or custody', async status => {
    const { id } = await store.create(payload(), owner);
    await db.getRepository(ProServiceCase).update(id, { status, acceptedAt: new Date(), acceptedQuoteVersion: 2, quote: { version: 2 } as any });
    await db.query(`INSERT INTO pro_service_ledger("caseId",kind,"amountMinor",currency,reference,evidence,"recordedBy") VALUES($1,'funding',100,'CDF','test-ref','test-proof',$2)`, [id, owner]);
    await db.query(`INSERT INTO pro_service_documents("caseId",code,label,status) VALUES($1,'carte-rose','Test','held')`, [id]);
    const item = await find(id), dto = edit(item);
    await expect(store.updateDocumentCase(id, owner, { ...dto, application: { ...dto.application, documents: ['assurance-auto'] } })).rejects.toThrow('sans modifier');
    await expect(store.updateDocumentCase(id, owner, { ...dto, application: { ...dto.application, phone: '+0000000001' } })).rejects.toThrow('sans modifier');
    await store.updateDocumentCase(id, owner, dto);
    expect(await find(id)).toMatchObject({ status, quote: item.quote, acceptedAt: item.acceptedAt, acceptedQuoteVersion: 2,
      application: { ...dto.application, documents: ['assurance-auto', 'carte-rose'] } });
    expect(await db.query('SELECT kind,"amountMinor" FROM pro_service_ledger')).toEqual([{ kind: 'funding', amountMinor: 100 }]);
    expect(await db.query('SELECT status FROM pro_service_documents')).toEqual([{ status: 'held' }]);
    const event = await db.getRepository(ProServiceEvent).findOneByOrFail({ caseId: id, action: 'application_updated' });
    expect(event.detail).toMatchObject({ editMode: 'add_documents', addedDocuments: ['assurance-auto'], invalidatedQuoteVersion: null });
  });
  it('protects ownership, active accounts and other services', async () => {
    const { id } = await store.create(payload(), owner); const dto = edit(await find(id));
    await expect(store.updateDocumentCase(id, other, dto)).rejects.toBeInstanceOf(NotFoundException);
    await db.query('UPDATE users SET "isActive"=false WHERE id=$1', [owner]);
    await expect(store.updateDocumentCase(id, owner, dto)).rejects.toThrow('compte');
    await db.query('UPDATE users SET "isActive"=true WHERE id=$1', [owner]);
    await db.getRepository(ProServiceCase).update(id, { serviceCode: 'vehicles' });
    await expect(store.updateDocumentCase(id, owner, dto)).rejects.toThrow('ne peut plus être modifiée');
  });
  it('cannot bypass the rule by linking a public dossier, and never infers ownership from its phone', async () => {
    await store.create(payload(), owner);
    const anonymous = await store.create(payload(), null);
    await expect(workflow.linkOwner(anonymous.id, other, { ownerId: owner, evidence: 'Identity verified for fixture' })).rejects.toBeInstanceOf(ConflictException);
    expect((await find(anonymous.id)).ownerId).toBeNull();
  });
  it('rolls back the edit if audit persistence fails', async () => {
    const { id } = await store.create(payload(), owner); const before = await find(id);
    await db.query(`ALTER TABLE pro_service_events ADD CONSTRAINT fail_edit_audit CHECK(action <> 'application_updated')`);
    try {
      await expect(store.updateDocumentCase(id, owner, edit(before))).rejects.toMatchObject({ code: '23514' });
      expect(await find(id)).toEqual(before);
    } finally { await db.query('ALTER TABLE pro_service_events DROP CONSTRAINT fail_edit_audit'); }
  });
});

describe('document amendment transport', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const valid = { mutationId: randomUUID(), expectedUpdatedAt: '2026-11-09T12:00:00.000Z', contactConsent: true,
    application: { fullName: 'Test applicant', phone: '+0000000000', vehicleDescription: '', documents: ['carte-rose'], description: '' } };
  const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateDocumentCaseDto });
  it('requires a dated snapshot, explicit consent and a mutation reference', async () => {
    await expect(validate(valid)).resolves.toBeInstanceOf(UpdateDocumentCaseDto);
    for (const patch of [{ mutationId: 'bad' }, { expectedUpdatedAt: 'yesterday' }, { contactConsent: false }, { application: null }, { ownerId: randomUUID() }, { status: 'accepted' }, { quote: {} }])
      await expect(validate({ ...valid, ...patch })).rejects.toThrow();
  });
});
