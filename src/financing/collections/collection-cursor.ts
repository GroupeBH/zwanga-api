import { BadRequestException } from '@nestjs/common';
import { isISO8601, isUUID } from 'class-validator';

export interface HistoryCursor {
  v: 1;
  type: 'history';
  creditId: string;
  at: string;
  id: string;
}
export interface DebtorsCursor {
  v: 1;
  type: 'debtors';
  asOf: string;
  minDays: number;
  maxDays: number;
  daysLate: number;
  lateMinor: string;
  driverId: string;
}
export const encodeCollectionCursor = (value: HistoryCursor | DebtorsCursor) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const validTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value) &&
  isISO8601(value, { strict: true }) &&
  Number.isFinite(Date.parse(value));
const validDays = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 365000;
export function decodeCollectionCursor(
  raw: string,
): HistoryCursor | DebtorsCursor {
  try {
    if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw))
      throw Error();
    const value: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object') throw Error();
    const c = value as Record<string, unknown>;
    if (c.v !== 1) throw Error();
    if (
      c.type === 'history' &&
      typeof c.creditId === 'string' &&
      isUUID(c.creditId) &&
      typeof c.id === 'string' &&
      isUUID(c.id) &&
      validTime(c.at)
    )
      return c as unknown as HistoryCursor;
    if (
      c.type === 'debtors' &&
      validTime(c.asOf) &&
      Date.parse(c.asOf) <= Date.now() &&
      validDays(c.daysLate) &&
      validDays(c.minDays) &&
      validDays(c.maxDays) &&
      typeof c.lateMinor === 'string' &&
      /^[0-9]{1,40}$/.test(c.lateMinor) &&
      typeof c.driverId === 'string' &&
      isUUID(c.driverId)
    )
      return c as unknown as DebtorsCursor;
    throw Error();
  } catch {
    throw new BadRequestException('Curseur de recouvrement invalide.');
  }
}
