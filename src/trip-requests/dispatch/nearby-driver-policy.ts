export const NEARBY_DRIVER_RADIUS_METERS = 5000;
// Bounds transaction time, not total recipients: later ticks select unsent drivers.
export const NEARBY_DRIVER_BATCH_SIZE = 50;

/** Outer presence alias p; same latest-KYC and busy rules as driver activation/dispatch. */
export const ELIGIBLE_NEARBY_DRIVER_SQL = `
  EXISTS (SELECT 1 FROM users u WHERE u.id = p."driverId"
    AND u.role = 'driver' AND u."isActive" = true AND u.status NOT IN ('suspended', 'inactive')
    AND u."fcmToken" IS NOT NULL AND u."fcmToken" <> ''
    AND (SELECT k.status FROM kyc_documents k WHERE k."userId" = u.id
      ORDER BY k."createdAt" DESC, k.id DESC LIMIT 1) = 'approved')
  AND NOT EXISTS (SELECT 1 FROM trips t WHERE t."driverId" = p."driverId" AND
    (t.status = 'ongoing' OR (t.status = 'upcoming' AND
      t."departureDate" BETWEEN now() - interval '2 hours' AND now() + interval '30 minutes')))
  AND NOT EXISTS (SELECT 1 FROM trip_requests assigned WHERE assigned."selectedDriverId" = p."driverId"
    AND assigned.status = 'driver_selected' AND assigned."departureDateMax" > now() - interval '2 hours')`;

/** Filter before LIMIT so incompatible installations cannot starve later recipients. */
export function nearbyNotificationCapabilitySql(legacy: boolean): string {
  const suffixes = legacy ? ['', ':driver-v2', ':driver-v3'] : [':driver-v2', ':driver-v3'];
  return `EXISTS (SELECT 1 FROM driver_notification_clients c JOIN users u ON u.id = c."userId"
    WHERE c."userId" = p."driverId" AND c."tokenHash" IN (${suffixes.map(suffix =>
      `encode(sha256(convert_to(u."fcmToken" || '${suffix}', 'UTF8')), 'hex')`).join(',')}))`;
}
