import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { RedisService } from '../common/services/redis.service';

export type HistoryMessage = { role: string; content: string };
type History = { owner: string; messages: HistoryMessage[] };
export type ConversationSession = { id: string; owner: string; conversationToken?: string };
const TTL_SECONDS = 1800;
const INDEX = 'chatbot:v2:index';

export class ChatbotHistory {
  constructor(private readonly redis: RedisService, private readonly secret: string) {}
  private signature(payload: string) {
    if (!this.secret) throw new Error('Chatbot session signing is not configured');
    return createHmac('sha256', this.secret).update(`chatbot-session:v1:${payload}`).digest('hex');
  }
  open(userId: string, existing?: string, token?: string): ConversationSession {
    const anonymous = userId === 'anonymous';
    const id = existing || `${anonymous ? 'anon' : 'chat'}-${randomUUID()}`;
    if (!/^(anon|chat)-[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('Conversation expirée. Commencez une nouvelle conversation.');
    if (anonymous !== id.startsWith('anon-')) throw new ForbiddenException('Accès à cette conversation refusé.');
    if (!anonymous) return { id, owner: userId };
    let owner = `anonymous:${randomUUID()}`;
    if (existing) {
      try {
        const [payload, signature, extra] = (token ?? '').split('.');
        const expected = this.signature(payload);
        if (extra || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (session.id !== id || typeof session.owner !== 'string' || !session.owner.startsWith('anonymous:') ||
            !Number.isFinite(session.exp) || session.exp <= Date.now()) throw new Error();
        owner = session.owner;
      } catch { throw new ForbiddenException('Session de conversation expirée ou invalide.'); }
    }
    const payload = Buffer.from(JSON.stringify({ id, owner, exp: Date.now() + TTL_SECONDS * 1000 })).toString('base64url');
    return { id, owner, conversationToken: `${payload}.${this.signature(payload)}` };
  }
  private key(id: string) { return `chatbot:v2:history:${id}`; }
  async read(session: ConversationSession) {
    const saved = await this.redis.get<History>(this.key(session.id));
    if (saved && saved.owner !== session.owner) throw new ForbiddenException('Accès à cette conversation refusé.');
    return saved?.messages ?? [];
  }
  async save(session: ConversationSession, messages: HistoryMessage[]) {
    const saved = await this.redis.getClient().eval(`
      local existing = redis.call('GET', KEYS[2])
      if existing and cjson.decode(existing).owner ~= ARGV[5] then return 0 end
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
      redis.call('ZADD', KEYS[1], ARGV[2], KEYS[2])
      local overflow = redis.call('ZCARD', KEYS[1]) - 500
      if overflow > 0 then
        local oldest = redis.call('ZRANGE', KEYS[1], 0, overflow - 1)
        for _, item in ipairs(oldest) do redis.call('DEL', item); redis.call('ZREM', KEYS[1], item) end
      end
      redis.call('EXPIRE', KEYS[1], ARGV[4])
      return 1
    `, { keys: [INDEX, this.key(session.id)], arguments: [String(Date.now()), String(Date.now() + TTL_SECONDS * 1000),
      JSON.stringify({ owner: session.owner, messages: messages.slice(-20).map(message => ({ ...message, content: message.content.slice(0, 4000) })) }), String(TTL_SECONDS), session.owner] });
    if (saved !== 1) throw new ForbiddenException('Accès à cette conversation refusé.');
  }
  async clear(id: string, userId: string) {
    const session = this.open(userId, id);
    await this.read(session);
    const cleared = await this.redis.getClient().eval(`
      local existing = redis.call('GET', KEYS[2])
      if existing and cjson.decode(existing).owner ~= ARGV[1] then return -1 end
      if redis.call('EXISTS', KEYS[3]) == 1 then return -2 end
      redis.call('DEL', KEYS[2]); redis.call('ZREM', KEYS[1], KEYS[2])
      return 1
    `, { keys: [INDEX, this.key(id), `chatbot:v2:lock:${id}`], arguments: [userId] });
    if (cleared === -1) throw new ForbiddenException('Accès à cette conversation refusé.');
    if (cleared === -2) throw new HttpException('Une réponse est en cours. Réessayez dans un instant.', 429);
  }
  async acquire(id: string): Promise<() => Promise<void>> {
    const lease = randomUUID();
    const lock = `chatbot:v2:lock:${id}`;
    const slots = 'chatbot:v2:inference';
    const acquired = await this.redis.getClient().eval(`
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      if redis.call('ZCARD', KEYS[1]) >= 4 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
      redis.call('SET', KEYS[2], ARGV[3], 'PX', 45000)
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
      redis.call('PEXPIRE', KEYS[1], 45000)
      return 1
    `, { keys: [slots, lock], arguments: [String(Date.now()), String(Date.now() + 45000), lease] });
    if (acquired !== 1) throw new HttpException('L’assistant est occupé. Réessayez dans un instant.', 429);
    return async () => {
      await this.redis.getClient().eval(`
        redis.call('ZREM', KEYS[1], ARGV[1])
        if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
        return 1
      `, { keys: [slots, lock], arguments: [lease] });
    };
  }
}
