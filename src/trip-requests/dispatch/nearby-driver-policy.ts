import { driverScheduleConflictSql } from './driver-schedule-policy';

export const NEARBY_DRIVER_RADIUS_METERS = 5000;
// Bounds transaction time, not total recipients: later ticks select unsent drivers.
export const NEARBY_DRIVER_BATCH_SIZE = 50;

/** Outer presence alias p; same latest-KYC and busy rules as driver activation/dispatch. */
export const ELIGIBLE_DRIVER_ACCOUNT_SQL = `
  EXISTS (SELECT 1 FROM users u WHERE u.id = p."driverId"
    AND u.role = 'driver' AND u."isActive" = true AND u.status NOT IN ('suspended', 'inactive')
    AND u."fcmToken" IS NOT NULL AND u."fcmToken" <> ''
    AND (SELECT k.status FROM kyc_documents k WHERE k."userId" = u.id
      ORDER BY k."createdAt" DESC, k.id DESC LIMIT 1) = 'approved')`;

export const ELIGIBLE_NEARBY_DRIVER_SQL = `${ELIGIBLE_DRIVER_ACCOUNT_SQL}
  AND NOT ${driverScheduleConflictSql('p."driverId"', 'now()', "now() + interval '2 hours'")}`;
