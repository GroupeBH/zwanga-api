import { ChatbotHistory } from './chatbot-history';

describe('Chatbot conversation ownership', () => {
  const evalMock = jest.fn();
  const redis = { get: jest.fn(), del: jest.fn(), getClient: () => ({ eval: evalMock, zRem: jest.fn() }) };
  const store = new ChatbotHistory(redis as any, 'test-session-secret');
  beforeEach(() => { redis.get.mockReset(); evalMock.mockReset(); });
  it('requires the signed anonymous session, not just a conversation ID', () => {
    const session = store.open('anonymous');
    expect(() => store.open('anonymous', session.id)).toThrow();
    expect(store.open('anonymous', session.id, session.conversationToken).owner).toBe(session.owner);
    expect(() => store.open('anonymous', store.open('anonymous').id, session.conversationToken)).toThrow();
  });
  it('rejects a modified or expired anonymous session', () => {
    jest.useFakeTimers();
    try {
      const session = store.open('anonymous');
      expect(() => store.open('anonymous', session.id, session.conversationToken + 'x')).toThrow();
      jest.advanceTimersByTime(1800001);
      expect(() => store.open('anonymous', session.id, session.conversationToken)).toThrow();
    } finally { jest.useRealTimers(); }
  });
  it('separates public and authenticated histories and denies another account', async () => {
    const session = store.open('owner');
    expect(() => store.open('anonymous', session.id)).toThrow();
    redis.get.mockResolvedValue({ owner: 'owner', messages: [{ role: 'human', content: 'private' }] });
    await expect(store.read(store.open('other', session.id))).rejects.toThrow();
    await expect(store.clear(session.id, 'other')).rejects.toThrow();
    expect(redis.del).not.toHaveBeenCalled();
    await expect(store.read(session)).resolves.toHaveLength(1);
  });
  it('enforces ownership atomically when saving and bounds stored content', async () => {
    const session = store.open('owner');
    evalMock.mockResolvedValue(0);
    await expect(store.save(session, [])).rejects.toThrow('Accès');
    evalMock.mockResolvedValue(1);
    await store.save(session, Array.from({ length: 100 }, () => ({ role: 'human', content: 'x'.repeat(5000) })));
    const args = evalMock.mock.calls.at(-1)[1].arguments;
    expect(args[4]).toBe('owner');
    expect(JSON.parse(args[2]).messages).toHaveLength(20);
    expect(JSON.parse(args[2]).messages[0].content).toHaveLength(4000);
  });
  it('does not clear a history while a response is still being written', async () => {
    const session = store.open('owner');
    evalMock.mockResolvedValue(-2);
    await expect(store.clear(session.id, 'owner')).rejects.toThrow('réponse est en cours');
  });
});
