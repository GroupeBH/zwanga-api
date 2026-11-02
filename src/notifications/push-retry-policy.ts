import type { Notification } from './entities/notification.entity';
import { FirebaseDeliveryError } from './firebase-delivery-error';

// A new device token is a meaningful change. A permanent error is otherwise
// retained for diagnosis, not retried by every urgent scan. No invitation renewal.
export const PUSH_RETRY_ELIGIBLE_SQL = `(notification."pushRetryAt" IS NULL OR notification."pushRetryAt" <= now())
  AND (notification."pushPermanentFailure" = false OR EXISTS (SELECT 1 FROM users push_owner
    WHERE push_owner.id::text = notification."userId"::text AND push_owner."fcmToken" IS NOT NULL
      AND push_owner."fcmToken" <> '' AND push_owner."fcmToken" <> notification."fcmToken"))`;

export function recordPushFailure(
  notification: Notification,
  error?: unknown,
  now = Date.now(),
  random = Math.random,
): void {
  const details =
    error instanceof FirebaseDeliveryError ? error.details : undefined;
  notification.pushAttempts = Math.min(
    1000,
    (notification.pushAttempts ?? 0) + 1,
  );
  notification.pushPermanentFailure = details?.transient === false;
  const delay = Math.min(
    15 * 60_000,
    15_000 * 2 ** Math.min(6, notification.pushAttempts - 1),
  );
  notification.pushRetryAt = new Date(
    Math.max(
      now + delay + Math.floor(delay * 0.25 * random()),
      details?.retryAt ?? 0,
    ),
  );
}

export function urgentPushWorkers(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(20, n) : 8;
}
