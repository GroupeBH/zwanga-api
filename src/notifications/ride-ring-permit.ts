import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FORMAT = new RegExp(`^v1\\.(${UUID})\\.(${UUID})\\.([0-9]{13})\\.([A-Za-z0-9_-]{43})$`, 'i');
const signature = (secret: string, payload: string) => createHmac('sha256', secret)
  .update(`zwanga:ride-ring-check:v1:${payload}`).digest('base64url');

/** Capability to check ONE invitation, never to accept a ride or access an account. */
export function issueRideRingPermit(secret: unknown, id: string, user: string, until: number): string | undefined {
  if (typeof secret !== 'string' || secret.length < 32 || !Number.isSafeInteger(until)) return undefined;
  const payload = `v1.${id}.${user}.${until}`;
  const token = `${payload}.${signature(secret, payload)}`;
  return FORMAT.test(token) ? token : undefined;
}

export function readRideRingPermit(secret: unknown, token: unknown, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof token !== 'string' || token.length > 256) return null;
  const parts = FORMAT.exec(token);
  if (!parts) return null;
  const until = Number(parts[3]);
  if (until <= now || until > now + 60_000) return null;
  const expected = signature(secret, token.slice(0, token.lastIndexOf('.')));
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parts[4]))) return null;
  return { notificationId: parts[1], userId: parts[2], until };
}

export function needsRideRingPermit(data?: Record<string, unknown> | null): boolean {
  return data?.type === 'driver_dispatch_offer' || data?.type === 'trip_request_nearby';
}
