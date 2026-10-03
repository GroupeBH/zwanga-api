import { createHash } from 'node:crypto';

export interface ActivityRevision { revision: string; count: number }
export interface AccountActivity {
  schemaVersion: 1;
  userId: string;
  trips: ActivityRevision;
  bookings: ActivityRevision;
  requests: ActivityRevision;
  hasLiveActivity: boolean;
  passengerTrackingBookingId: string | null;
}
export type ActivityRow = Record<string, unknown> & { id: string };
const timestamp = (value: unknown) => value instanceof Date ? value.getTime() : Date.parse(String(value));

/** Stable semantic fingerprints, never a timestamp that changes on every read. */
export function activityRevision(rows: ActivityRow[]): ActivityRevision {
  const normalized = [...new Set(rows.map(row => JSON.stringify(
    Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])),
  )))].sort();
  return {
    count: new Set(rows.map(row => row.id)).size,
    revision: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}

export function trackingBookingId(rows: ActivityRow[], now: number): string | null {
  const eligible = rows.filter(row => ['pending', 'accepted', 'no_show'].includes(String(row.status))
    && !row.droppedOff && !row.droppedOffConfirmedByPassenger);
  const ongoing = eligible.find(row => ['accepted', 'no_show'].includes(String(row.status)) && row.tripStatus === 'ongoing');
  if (ongoing) return ongoing.id;
  return eligible.filter(row => {
    const offset = timestamp(row.departureDate) - now;
    return offset <= 2 * 60 * 60_000 && offset >= -12 * 60 * 60_000;
  }).sort((a, b) => Math.abs(timestamp(a.departureDate) - now)
    - Math.abs(timestamp(b.departureDate) - now))[0]?.id ?? null;
}
