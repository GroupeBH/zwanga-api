import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import type { Notification } from './entities/notification.entity';
import { PUSH_CLAIM_LEASE_MS } from './notification-push-claim';
import { PUSH_RETRY_ELIGIBLE_SQL } from './push-retry-policy';

export const URGENT_NOTIFICATION_TYPES = ['new_booking', 'driver_dispatch_offer', 'trip_request_nearby',
  'booking_response', 'trip_request_accepted', 'driver_offer', 'offer_accepted'];

/** One short atomic claim, committed before any transport or business checks.
 * Keep the existing lanes, age fairness, retry deadlines and reclaimable leases.
 * Notification columns have no ORM transformers: PostgreSQL returns dates/JSON.
 */
export async function claimTransactionalPushNotifications(
  repository: Pick<Repository<Notification>, 'query'>,
  urgent: boolean,
  limit: number,
): Promise<Notification[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25)
    throw new Error('Transactional push claim must contain between 1 and 25 notifications');
  const now = Date.now();
  const parameters: unknown[] = [
    URGENT_NOTIFICATION_TYPES, limit, `TRANSACTIONAL_PUSH_CLAIMED:${randomUUID()}`,
  ];
  if (urgent) parameters.push(new Date(now - 15_000), new Date(now - PUSH_CLAIM_LEASE_MS));
  return repository.query(`WITH due AS (
    SELECT notification.id FROM notifications notification
    WHERE notification."eventKey" IS NOT NULL
      AND COALESCE(notification.data ->> 'type', '') <> 'mobile_campaign'
      AND ${urgent
        ? "notification.data ->> 'type' = ANY($1::text[])"
        : "NOT (COALESCE(notification.data ->> 'type', '') = ANY($1::text[]))"}
      AND ${urgent
        ? `(notification.status = 'pending' AND notification."errorMessage" IS NULL
          OR notification.status = 'failed' AND notification."updatedAt" < $4
          OR notification.status = 'pending' AND notification."updatedAt" < $5)`
        : `notification.status = 'pending' AND notification."errorMessage" IS NULL`}
      AND notification."isActive" = true AND ${PUSH_RETRY_ELIGIBLE_SQL}
    ORDER BY notification."createdAt", notification.id LIMIT $2
    FOR UPDATE OF notification SKIP LOCKED
  ), claimed AS (
    UPDATE notifications notification
    SET status = 'pending', "errorMessage" = $3 || ':' || notification.id::text,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM due WHERE notification.id = due.id
    RETURNING notification.*
  ) SELECT * FROM claimed ORDER BY "createdAt", id`, parameters);
}
