import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { decodeMessageCursor, loadMessagePage } from './message-page';
import { ChatService } from './chat.service';
import type { Message } from './entities/message.entity';

const at = '2026-09-17T10:00:00.123456';
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function fixture(count: number) {
  const entities = Array.from({ length: count }, (_, i) => ({ id: id(count - i), createdAt: new Date(at) }));
  const raw = entities.map(() => ({ cursorTime: at }));
  const query = {
    where: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
    getRawAndEntities: jest.fn().mockResolvedValue({ entities, raw }),
  };
  const repository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
  return { query, repository, repo: repository as unknown as Repository<Message>, entities };
}

describe('cursor-based conversation history', () => {
  it('limits the read, preserves microseconds and orders identical timestamps by UUID', async () => {
    const app = fixture(51);
    const page = await loadMessagePage(app.repo, 'conversation', {});
    expect(page.data).toHaveLength(50);
    expect(app.query.take).toHaveBeenCalledWith(51);
    expect(app.query.where).toHaveBeenCalledWith('message.conversationId = :conversationId', { conversationId: 'conversation' });
    expect(app.query.addOrderBy).toHaveBeenCalledWith('message.id', 'DESC');
    expect(decodeMessageCursor(page.nextCursor!)).toEqual({ at, id: id(2) });
    expect(new Date(at).toISOString()).not.toContain('123456');
  });

  it('uses a parameterized keyset boundary, without requiring the cursor message to still exist', async () => {
    const app = fixture(1);
    const before = Buffer.from(JSON.stringify({ at, id: id(999) })).toString('base64url');
    const page = await loadMessagePage(app.repo, 'conversation', { before, limit: 20 });
    expect(app.query.andWhere).toHaveBeenCalledWith(
      '(message.createdAt, message.id) < (:at::timestamp, :id::uuid)', { at, id: id(999) },
    );
    expect(page.nextCursor).toBeNull();
    expect(app.query.take).toHaveBeenCalledWith(21);
  });

  it('returns an empty final page and bounds the limit defensively', async () => {
    const app = fixture(0);
    expect(await loadMessagePage(app.repo, 'conversation', { limit: 10000 })).toEqual({ data: [], nextCursor: null, previousCursor: null, newestCursor: null });
    expect(app.query.take).toHaveBeenCalledWith(101);
  });

  it.each(['not-json', Buffer.from(JSON.stringify({ at: 'bad', id: id(1) })).toString('base64url'),
    Buffer.from(JSON.stringify({ at, id: "' OR 1=1" })).toString('base64url')])('rejects invalid cursor %s before the query', async before => {
    const app = fixture(0);
    await expect(loadMessagePage(app.repo, 'conversation', { before })).rejects.toBeInstanceOf(BadRequestException);
    expect(app.repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('retains the membership check before any message read', async () => {
    const app = fixture(1);
    const service = Object.create(ChatService.prototype) as ChatService;
    Object.assign(service, {
      messageRepository: app.repo,
      ensureUserInConversation: jest.fn().mockRejectedValue(new ForbiddenException()),
    });
    await expect(service.getConversationMessagePage('conversation', 'stranger', {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(app.repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('allows bounded backwards navigation after eviction, using the exact timestamp boundary', async () => {
    const app = fixture(51);
    // The database returns ASC when reading towards newer messages.
    app.entities.reverse();
    const after = Buffer.from(JSON.stringify({ at, id: id(1) })).toString('base64url');
    const page = await loadMessagePage(app.repo, 'conversation', { after });
    expect(app.query.orderBy).toHaveBeenCalledWith('message.createdAt', 'ASC');
    expect(app.query.andWhere).toHaveBeenCalledWith('(message.createdAt, message.id) > (:at::timestamp, :id::uuid)', { at, id: id(1) });
    expect(page.data).toHaveLength(50);
    expect(page.data[0].id).toBe(id(50));
    expect(page.previousCursor).toBe(page.newestCursor);
    expect(page.nextCursor).toBeTruthy();
  });

  it('rejects ambiguous paging directions before reading messages', async () => {
    const app = fixture(0);
    await expect(loadMessagePage(app.repo, 'conversation', { before: 'x', after: 'y' })).rejects.toBeInstanceOf(BadRequestException);
    expect(app.repository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
