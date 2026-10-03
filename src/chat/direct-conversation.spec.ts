import { resolveDirectConversation } from './direct-conversation';
import { Conversation } from './entities/conversation.entity';

describe('direct conversation resolution', () => {
  function fixture(existing: any = null) {
    const qb: any = {};
    for (const key of ['innerJoin', 'where', 'andWhere', 'orderBy', 'addOrderBy']) qb[key] = jest.fn().mockReturnValue(qb);
    qb.getOne = jest.fn(async () => existing);
    const insert = jest.fn().mockResolvedValue(undefined);
    const conversations = { createQueryBuilder: () => qb, create: value => value,
      save: jest.fn(async value => { existing = { ...value, id: 'conversation' }; return existing; }) };
    const manager = { query: jest.fn().mockResolvedValue([]), getRepository: entity => entity === Conversation ? conversations : { insert } };
    let previous = Promise.resolve();
    const repository: any = { manager: { transaction: fn => { const next = previous.then(() => fn(manager)); previous = next.catch(() => undefined); return next; } } };
    return { repository, qb, conversations, insert, manager };
  }
  it('reuses an exact pair without loading the inbox or adding participants', async () => {
    const f = fixture({ id: 'existing' });
    expect(await resolveDirectConversation(f.repository, 'a', 'b')).toEqual({ id: 'existing' });
    expect(f.conversations.save).not.toHaveBeenCalled(); expect(f.insert).not.toHaveBeenCalled();
    expect(f.qb.andWhere).toHaveBeenCalledWith('conversation.bookingId IS NULL');
    expect(f.qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'));
  });
  it('locks the normalized pair and creates once under serialized transactions', async () => {
    const f = fixture();
    await Promise.all([resolveDirectConversation(f.repository, 'a', 'b'), resolveDirectConversation(f.repository, 'b', 'a')]);
    expect(f.conversations.save).toHaveBeenCalledTimes(1);
    expect(f.insert).toHaveBeenCalledWith([{ conversationId: 'conversation', userId: 'a' }, { conversationId: 'conversation', userId: 'b' }]);
    expect(f.manager.query.mock.calls.every(call => call[1][0] === 'direct-conversation:a:b')).toBe(true);
  });
  it('rejects self before any transaction', async () => {
    const f = fixture(); await expect(resolveDirectConversation(f.repository, 'a', 'a')).rejects.toThrow();
    expect(f.manager.query).not.toHaveBeenCalled();
  });
});
