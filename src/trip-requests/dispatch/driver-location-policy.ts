// Outer alias p. A durable last-known position is independent of its old lease.
// NULL is a pre-migration row, false is an explicit opt-out, true is durable.
export const USABLE_DRIVER_LOCATION_SQL = `(p."discoveryEnabled" = true OR
  (p."discoveryEnabled" IS NULL AND p."expiresAt" > now()))`;

/** Ranking only: an old durable position stays eligible, but drivers located recently
 * are invited first so a phone last seen days ago does not take the first 40-second turn. */
export const RECENT_DRIVER_POSITION_MINUTES = 30;
export const STALE_PRESENCE_RANK_SQL = `(p."updatedAt" IS NULL OR
  p."updatedAt" < now() - interval '${RECENT_DRIVER_POSITION_MINUTES} minutes')`;

/** For discovery queries already joined to the ongoing trip (t) and presence (p).
 * Prefer the newest GPS fix; an older nearby trip point cannot override a newer
 * discovery fix in another city. On equal timestamps, prefer active navigation. */
const latestDriverValueSql = (navigation: string, discovery: string) => `(CASE
  WHEN t."currentLocation" IS NOT NULL AND (NOT COALESCE(${USABLE_DRIVER_LOCATION_SQL}, false) OR
    (t."lastLocationUpdateAt" IS NOT NULL AND
      (p."updatedAt" IS NULL OR t."lastLocationUpdateAt" >= p."updatedAt")))
  THEN ${navigation} WHEN ${USABLE_DRIVER_LOCATION_SQL} THEN ${discovery} END)`;
export const ONGOING_DRIVER_POSITION_SQL = latestDriverValueSql('t."currentLocation"', 'p.position');
export const ONGOING_DRIVER_POSITION_TIME_SQL = latestDriverValueSql('t."lastLocationUpdateAt"', 'p."updatedAt"');
export const STALE_ONGOING_POSITION_RANK_SQL = `(${ONGOING_DRIVER_POSITION_TIME_SQL} IS NULL OR
  ${ONGOING_DRIVER_POSITION_TIME_SQL} < now() - interval '${RECENT_DRIVER_POSITION_MINUTES} minutes')`;

export function hasUsableDriverLocation(
  presence: { discoveryEnabled?: boolean | null; expiresAt: Date | string } | undefined,
  now = Date.now(),
): boolean {
  if (!presence || presence.discoveryEnabled === false) return false;
  return presence.discoveryEnabled === true || new Date(presence.expiresAt).getTime() > now;
}
