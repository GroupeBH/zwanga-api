// Outer alias p. A durable last-known position is independent of its old lease.
// NULL is a pre-migration row, false is an explicit opt-out, true is durable.
export const USABLE_DRIVER_LOCATION_SQL = `(p."discoveryEnabled" = true OR
  (p."discoveryEnabled" IS NULL AND p."expiresAt" > now()))`;

export function hasUsableDriverLocation(
  presence: { discoveryEnabled?: boolean | null; expiresAt: Date | string } | undefined,
  now = Date.now(),
): boolean {
  if (!presence || presence.discoveryEnabled === false) return false;
  return presence.discoveryEnabled === true || new Date(presence.expiresAt).getTime() > now;
}
