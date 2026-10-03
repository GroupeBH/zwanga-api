import { loadConversationSummaries } from './conversation-summaries';

describe('Batched conversation summaries', () => {
  it('uses two queries for a full page and preserves counts and last messages', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `conversation-${index}`);
    const query: any = {};
    for (const name of ['distinctOn', 'leftJoinAndSelect', 'where', 'orderBy', 'addOrderBy', 'innerJoin', 'select', 'addSelect', 'andWhere', 'groupBy']) query[name] = jest.fn().mockReturnValue(query);
    query.getMany = jest.fn().mockResolvedValue([{ id: 'last', conversationId: ids[0] }]);
    query.getRawMany = jest.fn().mockResolvedValue([{ conversationId: ids[0], count: '7' }]);
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const results = await loadConversationSummaries(repository as any, ids, 'viewer');
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(results.get(ids[0])).toMatchObject({ lastMessage: { id: 'last' }, unreadCount: 7 });
    expect(results.get(ids[1])).toEqual({ lastMessage: null, unreadCount: 0 });
    expect(query.innerJoin.mock.calls[0][3]).toEqual({ userId: 'viewer' });
  });
  it('does not query for an empty authorized page', async () => {
    await expect(loadConversationSummaries({} as any, [], 'viewer')).resolves.toEqual(new Map());
  });
});
