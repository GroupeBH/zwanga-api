import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Message } from './entities/message.entity';
import type { MessagePageDto } from './dto/message-page.dto';

export function decodeMessageCursor(value?: string) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof cursor.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(cursor.at)
      || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) throw Error();
    return cursor as { at: string; id: string };
  } catch { throw new BadRequestException('La page de messages demandée est invalide.'); }
}

export async function loadMessagePage(repository: Repository<Message>, conversationId: string, options: MessagePageDto) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const cursor = decodeMessageCursor(options.before);
  const query = repository.createQueryBuilder('message')
    .where('message.conversationId = :conversationId', { conversationId })
    // Preserve PostgreSQL microseconds in the cursor; JS Date only preserves milliseconds.
    .addSelect(`to_char(message.createdAt, 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'cursorTime')
    .orderBy('message.createdAt', 'DESC').addOrderBy('message.id', 'DESC').take(limit + 1);
  if (cursor) query.andWhere('(message.createdAt, message.id) < (:at::timestamp, :id::uuid)', cursor);
  const { entities, raw } = await query.getRawAndEntities();
  const data = entities.slice(0, limit);
  const last = data.at(-1);
  return {
    data,
    nextCursor: entities.length > limit && last
      ? Buffer.from(JSON.stringify({ at: raw[limit - 1].cursorTime, id: last.id })).toString('base64url') : null,
  };
}
