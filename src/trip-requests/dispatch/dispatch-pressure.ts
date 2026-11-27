import type { DataSource } from 'typeorm';

/** A scheduling hint, never a permission check. Observe the existing primary
 * pool without acquiring another connection. Back off NEW invitations early,
 * not GPS, receipts, responses or the retirement of an already expired offer. */
export function dispatchPoolBusy(db: DataSource): boolean {
  const pool = (db.driver as unknown as { master?: { waitingCount?: number } } | undefined)?.master;
  return typeof pool?.waitingCount === 'number' && pool.waitingCount >= 2;
}

export const DISPATCH_PRESSURE_RETRY_MS = 250;
