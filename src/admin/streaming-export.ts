import { ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { SpreadsheetDownload, SpreadsheetFile } from './spreadsheet';

const PAGE_SIZE = 500;
let activeExports = 0;

// Only for our own buildSpreadsheet output, never imported XML. Reuse the
// existing, escaped cell mapping and headers instead of maintaining two formats.
function parts(file: SpreadsheetFile) {
  const xml = file.buffer.toString('utf8');
  const start = xml.indexOf('</Row>') + '</Row>'.length;
  const end = xml.lastIndexOf('</Table>');
  if (start < 6 || end < start)
    throw new Error('Invalid internal spreadsheet format');
  return {
    prefix: xml.slice(0, start),
    rows: xml.slice(start, end),
    suffix: xml.slice(end),
  };
}

/** One bounded query/buffer at a time; no long transaction or pinned SQL client.
 * Streaming errors close the download (never return a silently truncated XLS).
 * Client disconnect and an absolute deadline stop further page reads. */
export async function streamExport<T>(
  load: (offset: number, limit: number) => Promise<T[]>,
  render: (rows: T[]) => SpreadsheetFile | Promise<SpreadsheetFile>,
): Promise<SpreadsheetDownload> {
  if (activeExports >= 2)
    throw new ServiceUnavailableException({
      code: 'EXPORT_BUSY',
      message:
        'Deux exports sont déjà en cours. Réessayez dans quelques instants.',
    });
  activeExports++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeExports--;
    }
  };
  const started = Date.now();
  try {
    const first = await load(0, PAGE_SIZE);
    const file = await render(first);
    if (first.length < PAGE_SIZE) {
      release();
      return file;
    }
    const initial = parts(file);
    const source = async function* () {
      try {
        yield Buffer.from(initial.prefix + initial.rows, 'utf8');
        for (let offset = PAGE_SIZE; ; offset += PAGE_SIZE) {
          if (Date.now() - started > 300_000)
            throw new Error('Export deadline exceeded');
          const page = await load(offset, PAGE_SIZE);
          if (page.length) {
            const next = parts(await render(page));
            if (
              next.prefix !== initial.prefix ||
              next.suffix !== initial.suffix
            )
              throw new Error('Spreadsheet columns changed during export');
            yield Buffer.from(next.rows, 'utf8');
          }
          if (page.length < PAGE_SIZE) break;
        }
        yield Buffer.from(initial.suffix, 'utf8');
      } finally {
        release();
      }
    };
    const stream = Readable.from(source(), {
      objectMode: false,
      highWaterMark: 64 * 1024,
    });
    const timer = setTimeout(
      () => stream.destroy(new Error('Export deadline exceeded')),
      Math.max(1, 300_000 - (Date.now() - started)),
    );
    timer.unref();
    // A disconnected HTTP client may never attach a pipe/error handler. Keep
    // the error observable by consumers without crashing the API process.
    stream.on('error', () => {});
    stream.once('close', () => {
      clearTimeout(timer);
      release();
    });
    return { stream, filename: file.filename, contentType: file.contentType };
  } catch (error) {
    release();
    throw error;
  }
}

/** Stable keyset on immutable createdAt/id, no ever-growing OFFSET scans. */
export function exportCreatedPages<
  T extends ObjectLiteral & { id: string; createdAt: Date },
>(query: SelectQueryBuilder<T>, alias: string) {
  // Alias is supplied by our code, never a query parameter.
  if (!/^[a-zA-Z]+$/.test(alias)) throw new Error('Invalid export alias');
  let cursor: { id: string; timestamp: string } | undefined;
  const cutoff = new Date();
  return async (_offset: number, limit: number) => {
    const page = query
      .clone()
      .andWhere(`${alias}.createdAt <= :exportCutoff`, { exportCutoff: cutoff })
      .orderBy(`${alias}.createdAt`, 'DESC')
      .addOrderBy(`${alias}.id`, 'DESC')
      .take(limit)
      .addSelect(`${alias}."createdAt"::text`, '__exportCreatedAt')
      .addSelect(`${alias}.id::text`, '__exportId');
    // Keep microseconds in the cursor, even if the boundary row is deleted.
    if (cursor)
      page.andWhere(
        `(${alias}."createdAt", ${alias}.id) < (:exportDate, :exportId)`,
        { exportId: cursor.id, exportDate: cursor.timestamp },
      );
    const { entities, raw } = await page.getRawAndEntities();
    if (entities.length) {
      const id = entities[entities.length - 1].id;
      const value = raw.find((row) => row.__exportId === id)?.__exportCreatedAt;
      if (typeof value !== 'string')
        throw new Error('Missing export timestamp cursor');
      cursor = { id, timestamp: value };
    }
    return entities;
  };
}

/** Custom user/alphabetical and mutable updatedAt ordering: preserve the
 * existing order with bounded pages, without promising a frozen snapshot. */
export function exportOffsetPages<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  alias: string,
) {
  const cutoff = new Date();
  return (offset: number, limit: number) =>
    query
      .clone()
      .andWhere(`${alias}.createdAt <= :exportCutoff`, { exportCutoff: cutoff })
      .skip(offset)
      .take(limit)
      .getMany();
}
