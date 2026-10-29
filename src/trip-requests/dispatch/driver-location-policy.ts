// Outer alias p. A durable last-known position is independent of its old lease.
// NULL is a pre-migration row, false is an explicit opt-out, true is durable.
export const USABLE_DRIVER_LOCATION_SQL = `(p."discoveryEnabled" = true OR
  (p."discoveryEnabled" IS NULL AND p."expiresAt" > now()))`;

/** For discovery queries already joined to the ongoing trip (t) and presence (p).
 * Prefer the newest GPS fix; an older nearby trip point cannot override a newer
 * discovery fix in another city. On equal timestamps, prefer active navigation. */
export const ONGOING_DRIVER_POSITION_SQL = `(CASE
  WHEN t."currentLocation" IS NOT NULL AND (NOT COALESCE(${USABLE_DRIVER_LOCATION_SQL}, false) OR
    (t."lastLocationUpdateAt" IS NOT NULL AND
      (p."updatedAt" IS NULL OR t."lastLocationUpdateAt" >= p."updatedAt")))
  THEN t."currentLocation" WHEN ${USABLE_DRIVER_LOCATION_SQL} THEN p.position END)`;

export function hasUsableDriverLocation(
  presence: { discoveryEnabled?: boolean | null; expiresAt: Date | string } | undefined,
  now = Date.now(),
): boolean {
  if (!presence || presence.discoveryEnabled === false) return false;
  return presence.discoveryEnabled === true || new Date(presence.expiresAt).getTime() > now;
}
