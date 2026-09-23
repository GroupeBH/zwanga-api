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
  if (options.before && options.after) throw new BadRequestException('Choisissez une seule direction de pagination.');
  const newer = Boolean(options.after);
  const cursor = decodeMessageCursor(options.before ?? options.after);
  const query = repository.createQueryBuilder('message')
    .where('message.conversationId = :conversationId', { conversationId })
    // Preserve PostgreSQL microseconds in the cursor; JS Date only preserves milliseconds.
    .addSelect(`to_char(message.createdAt, 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'cursorTime')
    .orderBy('message.createdAt', newer ? 'ASC' : 'DESC').addOrderBy('message.id', newer ? 'ASC' : 'DESC').take(limit + 1);
  if (cursor) query.andWhere(`(message.createdAt, message.id) ${newer ? '>' : '<'} (:at::timestamp, :id::uuid)`, cursor);
  const { entities, raw } = await query.getRawAndEntities();
  const rows = entities.slice(0, limit).map((message, index) => ({ message,
    cursor: Buffer.from(JSON.stringify({ at: raw[index].cursorTime, id: message.id })).toString('base64url') }));
  if (newer) rows.reverse();
  const data = rows.map(row => row.message);
  return {
    data,
    newestCursor: rows[0]?.cursor ?? null,
    nextCursor: (newer || entities.length > limit) ? rows.at(-1)?.cursor ?? null : null,
    previousCursor: (options.before || (newer && entities.length > limit)) ? rows[0]?.cursor ?? null : null,
  };
}
