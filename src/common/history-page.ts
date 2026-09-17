import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export class HistoryPageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
  @IsOptional() @IsString() @MaxLength(1024)
  before?: string;
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;
}

type Kind = 'trips' | 'bookings';
type Cursor = { at: string; id: string; asOf: string; kind: Kind; search: string };
export const normalizeHistorySearch = (value = '') => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function historyContext(options: HistoryPageQuery, kind: Kind, now = new Date()) {
  const search = normalizeHistorySearch(options.search);
  let cursor: Cursor | null = null;
  if (options.before) {
    try {
      cursor = JSON.parse(Buffer.from(options.before, 'base64url').toString('utf8'));
      if (!cursor || cursor.kind !== kind || cursor.search !== search
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(cursor.at)
        || !Number.isFinite(Date.parse(cursor.at)) || !Number.isFinite(Date.parse(cursor.asOf))
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) throw Error();
    } catch { throw new BadRequestException('La page demandée est invalide. Actualisez la liste.'); }
  }
  return { cursor, search, asOf: cursor?.asOf ?? now.toISOString(), kind };
}

export function applyHistorySearch<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, search: string, columns: string[]) {
  if (!search) return;
  // Fixed, internal column names only; user text is always a bound literal.
  const text = `translate(lower(concat_ws(' ', ${columns.join(', ')})), 'àâäáãåçéèêëìíîïñòóôöõùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;
  query.andWhere(`${text} LIKE :historySearch ESCAPE '!'`, {
    historySearch: `%${search.replace(/[!%_]/g, '!$&')}%`,
  });
}

/** Page IDs before loading to-many relations; joined booking rows cannot distort the limit. */
export async function loadHistoryIds<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>, options: HistoryPageQuery,
  context: ReturnType<typeof historyContext>, idColumn: string, dateColumn: string,
) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  if (context.cursor) query.andWhere(`(${dateColumn}, ${idColumn}) < (:at::timestamp, :cursorId::uuid)`,
    { at: context.cursor.at, cursorId: context.cursor.id });
  const rows = await query.select(idColumn, 'id')
    .addSelect(`to_char(${dateColumn}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'at')
    .orderBy(dateColumn, 'DESC').addOrderBy(idColumn, 'DESC').limit(limit + 1)
    .getRawMany<{ id: string; at: string }>();
  const selected = rows.slice(0, limit), last = selected.at(-1);
  return { ids: selected.map(row => row.id), nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ ...last, asOf: context.asOf, kind: context.kind, search: context.search })).toString('base64url') : null };
}

export function orderHistory<T extends { id: string }>(ids: string[], records: T[]) {
  const byId = new Map(records.map(record => [record.id, record]));
  return ids.flatMap(id => { const record = byId.get(id); return record ? [record] : []; });
}
