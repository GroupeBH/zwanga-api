import { ValidationPipe } from '@nestjs/common';
import { RatingsService } from './ratings.service';
import { HistoryPageDto } from '../common/pagination/history-page';

const ids = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'];
const cursorTime = '2026-10-10T10:00:00.123456';
function fixture() {
  const query = {
    leftJoin: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(),
    clone: jest.fn(() => ({ getCount: async () => 90 })),
    getRawAndEntities: jest.fn(async () => ({ entities: ids.map(id => ({ id })), raw: ids.map(() => ({ cursorTime })) })),
  };
  const repository = { createQueryBuilder: jest.fn(() => query) };
  const service = new RatingsService(repository as never, {} as never);
  return { service, query };
}

describe('Public review pages', () => {
  it('preserves the legacy array while selecting only public author fields', async () => {
    const find = jest.fn(async () => [{ id: ids[0] }]);
    const service = new RatingsService({ find } as never, {} as never);
    expect(await service.findByUser(ids[0])).toEqual([{ id: ids[0] }]);
    expect(find.mock.calls[0]?.[0]).toMatchObject({
      select: { rater: { id: true, firstName: true, lastName: true, profilePicture: true } },
    });
    const projection = (find.mock.calls as any)[0][0].select.rater;
    expect(Object.keys(projection).sort()).toEqual(['firstName', 'id', 'lastName', 'profilePicture']);
  });
  it('bounds the response, preserves the total and excludes private rater fields', async () => {
    const { service, query } = fixture();
    const result = await service.findPage(ids[0], { limit: 2 });
    expect(query.where).toHaveBeenCalledWith('entry.ratedUserId = :userId', { userId: ids[0] });
    expect(query.take).toHaveBeenCalledWith(3);
    expect(query.addOrderBy).toHaveBeenCalledWith('entry.id', 'DESC');
    expect(query.select.mock.calls[0][0]).toEqual(['entry.id', 'entry.ratedUserId', 'entry.raterId', 'entry.tripId',
      'entry.rating', 'entry.comment', 'entry.createdAt', 'rater.id', 'rater.firstName', 'rater.lastName', 'rater.profilePicture']);
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(90);
    expect(JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString())).toEqual({ at: cursorTime, id: ids[1] });
  });

  it('uses the exact timestamp and id cursor and rejects malformed cursors', async () => {
    const { service, query } = fixture();
    const first = await service.findPage(ids[0], { limit: 2 });
    await service.findPage(ids[0], { limit: 2, before: first.nextCursor! });
    expect(query.andWhere).toHaveBeenCalledWith('(entry.createdAt, entry.id) < (:at::timestamp, :id::uuid)', { at: cursorTime, id: ids[1] });
    await expect(service.findPage(ids[0], { before: 'invalid' })).rejects.toThrow();
  });

  it('validates the page size at the HTTP boundary', async () => {
    const pipe = new ValidationPipe({ transform: true });
    for (const limit of ['0', '51', 'invalid']) {
      await expect(pipe.transform({ limit }, { type: 'query', metatype: HistoryPageDto })).rejects.toThrow();
    }
    expect(await pipe.transform({ limit: '3' }, { type: 'query', metatype: HistoryPageDto })).toMatchObject({ limit: 3 });
  });
});
