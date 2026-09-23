import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { decodeMessageCursor } from '../../chat/message-page';

export class HistoryPageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit?: number;
  @IsOptional() @IsString() @MaxLength(256)
  before?: string;
}
export class PaymentHistoryPageDto extends HistoryPageDto {
  @IsOptional() @IsIn(['all', 'succeeded', 'pending', 'failed'])
  filter?: 'all' | 'succeeded' | 'pending' | 'failed';
}

/** The builder must already be scoped to the authenticated account. Expressions are internal constants. */
export async function loadHistoryPage<T extends ObjectLiteral & { id: string }>(
  query: SelectQueryBuilder<T>, options: HistoryPageDto, time = 'entry.createdAt',
) {
  const limit = Math.min(50, Math.max(1, options.limit ?? 25));
  let cursor: ReturnType<typeof decodeMessageCursor>;
  try { cursor = decodeMessageCursor(options.before); }
  catch { throw new BadRequestException("La page d'historique demandée est invalide."); }
  const totalQuery = query.clone();
  if (cursor) query.andWhere(`(${time}, entry.id) < (:at::timestamp, :id::uuid)`, cursor);
  query.addSelect(`to_char(${time}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'cursorTime')
    .orderBy(time, 'DESC').addOrderBy('entry.id', 'DESC').take(limit + 1);
  const [{ entities, raw }, total] = await Promise.all([query.getRawAndEntities(), totalQuery.getCount()]);
  const data = entities.slice(0, limit);
  const last = data.at(-1);
  return { data, total, nextCursor: entities.length > limit && last
    ? Buffer.from(JSON.stringify({ at: raw[limit - 1].cursorTime, id: last.id })).toString('base64url') : null };
}
