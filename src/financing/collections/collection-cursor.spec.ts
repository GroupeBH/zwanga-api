import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  decodeCollectionCursor,
  encodeCollectionCursor,
  HistoryCursor,
} from './collection-cursor';

describe('Collection cursors', () => {
  const cursor: HistoryCursor = {
    v: 1,
    type: 'history',
    creditId: randomUUID(),
    id: randomUUID(),
    at: '2026-01-01T00:00:00.123456Z',
  };
  it('roundtrips without losing database microseconds', () => {
    expect(decodeCollectionCursor(encodeCollectionCursor(cursor))).toEqual(
      cursor,
    );
  });
  it.each([
    '',
    'garbage',
    'a'.repeat(2049),
    Buffer.from('null').toString('base64url'),
    Buffer.from(JSON.stringify({ ...cursor, v: 2 })).toString('base64url'),
    Buffer.from(JSON.stringify({ ...cursor, id: 'not-a-uuid' })).toString(
      'base64url',
    ),
    Buffer.from(
      JSON.stringify({ ...cursor, at: '2026-02-30T00:00:00.000Z' }),
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        v: 1,
        type: 'debtors',
        asOf: '2999-01-01T00:00:00.000Z',
        minDays: 0,
        maxDays: 365000,
        daysLate: 1,
        lateMinor: '100',
        driverId: randomUUID(),
      }),
    ).toString('base64url'),
  ])('rejects malformed or invalid cursor %#', (raw) => {
    expect(() => decodeCollectionCursor(raw)).toThrow(BadRequestException);
  });
});
