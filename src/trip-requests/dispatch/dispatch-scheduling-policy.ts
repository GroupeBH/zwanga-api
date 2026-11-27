/** A repeated wave loses its head start after 30s: new requests are favoured,
 * without permanently starving requests which already received an invitation.
 * Outer alias r. Invitation history remains the durable source of truth. */
export const REQUEST_DISPATCH_PRIORITY_SQL = `COALESCE((
  SELECT max(history."createdAt") + interval '30 seconds'
  FROM trip_request_dispatch_offers history WHERE history."requestId" = r.id
), r."createdAt")`;

export const EMPTY_DISCOVERY_RETRY_MS = [1000, 2000, 5000, 15000] as const;
