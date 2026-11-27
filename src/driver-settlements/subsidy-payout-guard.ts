import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { FIRST_TRIP_SUBSIDY_CAP_CDF } from '../bookings/first-trip-subsidy.policy';

/** Filter in the SAME statement as the balance sum: a concurrent earning insert
 * between the review check and balance read cannot become withdrawable. */
export const WITHDRAWABLE_EARNINGS_SUM_SQL = `COALESCE(SUM(CASE WHEN earning."proCreditPending"
  OR EXISTS (SELECT 1 FROM bookings b WHERE b.id=earning."bookingId"
    AND (b."firstTripSubsidyApplied" OR b."zwangaSubsidyAmount">0)
    AND (b."zwangaSubsidyAmount" IS NULL OR b."zwangaSubsidyAmount"::text='NaN'
      OR b."zwangaSubsidyAmount"<0 OR b."zwangaSubsidyAmount">${FIRST_TRIP_SUBSIDY_CAP_CDF}
      OR b."paymentCurrency" IS DISTINCT FROM 'CDF' OR earning.currency IS DISTINCT FROM 'CDF'))
  THEN 0 ELSE earning."netAmount" - earning."assetRepaymentAmount" - earning."proRepaymentAmount" END), 0)`;

/** No ledger erasure or fare change: legacy unsafe subsidy requires reconciliation. */
export async function hasSubsidyPayoutHold(
  manager: Pick<EntityManager, 'query'>,
  driverId: string,
): Promise<boolean> {
  const rows = await manager.query<unknown[]>(
    `SELECT 1 FROM driver_earnings e
    JOIN bookings b ON b.id=e."bookingId"
    WHERE e."driverId"=$1 AND e.status<>'cancelled'
      AND (b."firstTripSubsidyApplied" OR b."zwangaSubsidyAmount">0)
      AND (b."zwangaSubsidyAmount" IS NULL OR b."zwangaSubsidyAmount"::text='NaN'
        OR b."zwangaSubsidyAmount"<0 OR b."zwangaSubsidyAmount">$2
        OR b."paymentCurrency" IS DISTINCT FROM 'CDF' OR e.currency IS DISTINCT FROM 'CDF')
    LIMIT 1`,
    [driverId, FIRST_TRIP_SUBSIDY_CAP_CDF],
  );
  return rows.length > 0;
}

export async function assertNoSubsidyPayoutHold(
  manager: Pick<EntityManager, 'query'>,
  driverId: string,
) {
  if (await hasSubsidyPayoutHold(manager, driverId))
    throw new ConflictException({
      code: 'SUBSIDY_PAYOUT_REVIEW_REQUIRED',
      message:
        'Une subvention nécessite un rapprochement par l’assistance avant tout retrait. Le prix du passager reste inchangé.',
    });
}
