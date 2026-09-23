import { BadRequestException } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';
import { loadHistoryPage } from './history-page';
import { loadPaymentHistoryPage, loadPaymentHistorySummary } from '../../payments/payment-history-page';

const at = '2026-09-23T08:00:00.123456';
const uuid = '00000000-0000-4000-8000-000000000001';
const fixture = (count = 3) => {
  const query = {
    clone: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(900),
    getRawMany: jest.fn().mockResolvedValue([{ currency: 'CDF', amount: '19000.50' }]),
    getRawAndEntities: jest.fn().mockResolvedValue({ entities: Array.from({ length: count }, () => ({ id: uuid })),
      raw: Array.from({ length: count }, () => ({ cursorTime: at })) }),
  };
  return { query, builder: query as unknown as SelectQueryBuilder<{ id: string }>,
    repository: { createQueryBuilder: jest.fn().mockReturnValue(query) } as any };
};

describe('financial history pagination', () => {
  it('uses a bounded stable keyset, exact microseconds and a total independent of the current page', async () => {
    const f = fixture();
    const page = await loadHistoryPage(f.builder, { limit: 2 });
    expect(page.data).toHaveLength(2); expect(page.total).toBe(900);
    expect(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString())).toEqual({ at, id: uuid });
    expect(f.query.take).toHaveBeenCalledWith(3);
    await loadHistoryPage(f.builder, { limit: 2, before: page.nextCursor! });
    expect(f.query.andWhere).toHaveBeenCalledWith('(entry.createdAt, entry.id) < (:at::timestamp, :id::uuid)', { at, id: uuid });
  });
  it('rejects invalid cursors and does not fall back to an unbounded list', async () => {
    const f = fixture();
    await expect(loadHistoryPage(f.builder, { before: 'invalid' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(loadHistoryPage(f.builder, { before: 'invalid' })).rejects.toThrow("La page d'historique demandée est invalide.");
    expect(f.query.getRawAndEntities).not.toHaveBeenCalled();
  });
  it.each([['pending', ['pending', 'initiated']], ['failed', ['failed', 'cancelled']], ['succeeded', ['succeeded']]])(
    'keeps account isolation and the %s filter across pages', async (filter, statuses) => {
      const f = fixture();
      await loadPaymentHistoryPage(f.repository, 'authenticated-user', { filter: filter as any });
      expect(f.query.where).toHaveBeenCalledWith('entry.userId = :userId', { userId: 'authenticated-user' });
      expect(f.query.andWhere).toHaveBeenCalledWith('entry.status IN (:...statuses)', { statuses });
    });
  it('aggregates all successful payments by currency, without loading transaction objects', async () => {
    const f = fixture();
    expect(await loadPaymentHistorySummary(f.repository, 'user')).toEqual({ total: 900,
      succeededByCurrency: [{ currency: 'CDF', amount: 19000.5 }] });
    expect(f.query.getRawAndEntities).not.toHaveBeenCalled();
    expect(f.query.groupBy).toHaveBeenCalledWith('entry.currency');
  });
});
