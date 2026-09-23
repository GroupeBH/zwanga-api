import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { PaymentTransaction } from '../../payments/entities/payment-transaction.entity';
import { DriverEarning } from '../../driver-settlements/entities/driver-earning.entity';
import { DriverPayout } from '../../driver-settlements/entities/driver-payout.entity';
import { loadHistoryPage } from './history-page';

describe('financial history SQL projections (metadata only, no database connection)', () => {
  let source: DataSource;
  beforeAll(async () => {
    source = new DataSource({ type: 'postgres', database: 'metadata_only',
      entities: [join(__dirname, '..', '..', '**', '*.entity.ts')] });
    await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['payments', 'earnings', 'payouts'])('resolves %s account, ordering and cursor expressions against real entity metadata', async kind => {
    const entity = kind === 'payments' ? PaymentTransaction : kind === 'earnings' ? DriverEarning : DriverPayout;
    const query = source.getRepository(entity).createQueryBuilder('entry');
    query.where(kind === 'payments' ? 'entry.userId = :account' : 'entry.driverId = :account', { account: 'account-only' });
    if (kind === 'payouts') query.leftJoinAndSelect('entry.paymentTransaction', 'paymentTransaction');
    const time = kind === 'earnings' ? 'COALESCE(entry.availableAt, entry.createdAt)' : 'entry.createdAt';
    let pageSql = '', countSql = '';
    jest.spyOn(SelectQueryBuilder.prototype, 'getRawAndEntities').mockImplementation(async function () {
      pageSql = this.getQueryAndParameters()[0];
      expect(this.getQueryAndParameters()[1]).toContain('account-only');
      expect(this.expressionMap.take).toBe(26);
      return { entities: [], raw: [] };
    });
    jest.spyOn(SelectQueryBuilder.prototype, 'getCount').mockImplementation(async function () {
      countSql = this.getQueryAndParameters()[0]; return 40;
    });
    const before = Buffer.from(JSON.stringify({ at: '2026-09-23T08:00:00.123456',
      id: '00000000-0000-4000-8000-000000000001' })).toString('base64url');
    expect(await loadHistoryPage(query, { before }, time)).toEqual({ data: [], total: 40, nextCursor: null });
    expect(pageSql).toContain('::timestamp');
    expect(pageSql).toContain('"entry"."id" DESC');
    expect(pageSql).not.toMatch(/\bentry\.[a-zA-Z]/);
    expect(countSql).not.toContain('::timestamp');
    if (kind === 'earnings') expect(pageSql).toContain('COALESCE("entry"."availableAt", "entry"."createdAt")');
    if (kind === 'payouts') expect(pageSql).toContain('LEFT JOIN');
  });
});
