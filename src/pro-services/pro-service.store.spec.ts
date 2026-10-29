import { ProServiceStore } from './pro-service.store';
import { CreateServiceCaseDto } from './pro-service.dto';
import { ProServiceCase } from './pro-service.entities';
import { AddProServices1780000041000 } from '../database/migrations/1780000041000-AddProServices';

const payload: CreateServiceCaseDto = { serviceCode: 'documents', submissionKey: '00000000-0000-4000-8000-000000000001', contactConsent: true,
  application: { fullName: 'Test applicant', phone: '+0000000000', vehicleDescription: '', plate: '', documents: ['carte-rose'], description: '' } };
describe('Pro services intake', () => {
  function fixture(previous: Partial<ProServiceCase> | null = null) {
    const repo = { findOneBy: jest.fn().mockResolvedValue(previous) };
    const manager = { findOne: jest.fn().mockResolvedValue({ availability: 'open' }),
      create: jest.fn((_entity, value) => value), save: jest.fn((_entity, value) => Promise.resolve({ id: 'case', ...value })) };
    const db = { getRepository: jest.fn(() => repo), transaction: jest.fn(callback => callback(manager)) };
    const store = new ProServiceStore(db as any);
    return { store, db, manager };
  }
  it('accepts a public request with contact consent, never infers the owner from a phone', async () => {
    const f = fixture();
    await expect(f.store.create(payload, null)).resolves.toEqual({ id: 'case' });
    expect(f.manager.create).toHaveBeenCalledWith(ProServiceCase, expect.objectContaining({ ownerId: null, status: 'submitted', origin: 'web' }));
    expect(f.manager.findOne).toHaveBeenCalledTimes(1);
  });
  it('replays an identical request regardless of JSONB property order', async () => {
    const f = fixture({ id: 'case', serviceCode: 'documents', ownerId: null, application: { ...payload.application } });
    await expect(f.store.create(payload, null)).resolves.toEqual({ id: 'case' });
    expect(f.db.transaction).not.toHaveBeenCalled();
  });
  it('does not reuse another account’s submission key or altered payload', async () => {
    const f = fixture({ id: 'case', serviceCode: 'documents', ownerId: 'owner', application: payload.application });
    await expect(f.store.create(payload, null)).rejects.toThrow('déjà été utilisée');
    await expect(f.store.create({ ...payload, application: { ...payload.application, description: 'changed' } }, 'owner')).rejects.toThrow('déjà été utilisée');
  });
  it('blocks unconsented, unknown document and closed-service requests', async () => {
    const f = fixture();
    await expect(f.store.create({ ...payload, contactConsent: false }, null)).rejects.toThrow('accord');
    await expect(f.store.create({ ...payload, application: { ...payload.application, documents: ['unknown'] } }, null)).rejects.toThrow('document proposé');
    f.manager.findOne.mockResolvedValue({ availability: 'coming_soon' });
    await expect(f.store.create(payload, null)).rejects.toThrow('nouvelles demandes');
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('migration contains constraints and starts without any validated terms', async () => {
    const q = { query: jest.fn().mockResolvedValue([]) };
    await new AddProServices1780000041000().up(q as any);
    const sql = q.query.mock.calls.map(args => args[0]).join('\n');
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(5);
    expect(sql).toContain('pro_service_ledger_one_advance');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|UPDATE users|INSERT INTO pro_service_offerings\([^)]*terms/);
    const seeds = q.query.mock.calls.filter(args => args[0].startsWith('INSERT INTO pro_service_offerings'));
    expect(seeds).toHaveLength(4);
    expect(seeds.filter(args => args[1][3] === 'open')).toHaveLength(1);
  });
});

describe('Pro services list contract used by the admin table and CSV export', () => {
  function fixture(records: Partial<ProServiceCase>[]) {
    const query: any = {};
    for (const method of ['select', 'andWhere', 'orderBy', 'addOrderBy', 'take']) query[method] = jest.fn(() => query);
    query.getMany = jest.fn().mockResolvedValue(records);
    const repository = { createQueryBuilder: jest.fn(() => query) };
    const store = new ProServiceStore({ getRepository: () => repository } as any);
    return { store, query };
  }
  const record = (id = payload.submissionKey): Partial<ProServiceCase> => ({
    id, serviceCode: 'documents', status: 'submitted', createdAt: new Date('2026-10-29T10:00:00Z'), customerMessage: '',
    application: { ...payload.application, documents: ['carte-rose', 'nouveau-permis'] },
  });

  it('includes the submitted document codes and contact in the existing list, without exposing the full application', async () => {
    const row = record(), f = fixture([row]);
    const result = await f.store.list({});
    expect(result).toEqual({ items: [{ id: row.id, serviceCode: 'documents', status: 'submitted',
      createdAt: row.createdAt, customerMessage: '', fullName: payload.application.fullName,
      phone: payload.application.phone, documentCodes: ['carte-rose', 'nouveau-permis'] }], nextCursor: null });
    expect(result.items[0]).not.toHaveProperty('application');
    expect(result.items[0]).not.toHaveProperty('quote');
    expect(f.query.getMany).toHaveBeenCalledTimes(1); // No per-row detail requests.
  });

  it('keeps missing historical document selections empty instead of inventing requested documents', async () => {
    const row = record(); delete (row.application as any).documents; delete (row.application as any).phone;
    const f = fixture([row]);
    expect((await f.store.list({})).items[0]).toMatchObject({ phone: '', documentCodes: [] });
  });

  it('preserves owner/status filtering and bounded cursor pagination with documents on every row', async () => {
    const records = Array.from({ length: 21 }, (_, index) => record(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`));
    const f = fixture(records), page = await f.store.list({ status: 'submitted' }, 'owner');
    expect(f.query.andWhere).toHaveBeenCalledWith('c."ownerId" = :ownerId', { ownerId: 'owner' });
    expect(f.query.andWhere).toHaveBeenCalledWith('c.status = :status', { status: 'submitted' });
    expect(f.query.take).toHaveBeenCalledWith(21);
    expect(page.items).toHaveLength(20);
    expect(page.items.every(item => item.documentCodes.length === 2)).toBe(true);
    expect(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString())).toEqual({
      at: records[19].createdAt!.toISOString(), id: records[19].id,
    });
    await f.store.list({ cursor: page.nextCursor! }, 'owner');
    expect(f.query.andWhere).toHaveBeenCalledWith('(c."createdAt", c.id) < (:at, :id)', {
      at: records[19].createdAt!.toISOString(), id: records[19].id,
    });
  });
});
