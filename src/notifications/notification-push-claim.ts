import type { Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
} from './entities/notification.entity';

export const PUSH_CLAIM_LEASE_MS = 20_000;
export const PUSH_CLAIM_HEARTBEAT_MS = 5_000;
const claims = new WeakMap<Notification, string>();

export function ownPushClaim(notification: Notification, token: string): void {
  claims.set(notification, token);
}

/** Never renew or complete a replacement worker's claim. No HTTP under a lock. */
export async function renewPushClaim(
  repository: Repository<Notification>,
  notification: Notification,
): Promise<boolean> {
  const token = claims.get(notification);
  if (!token) return true;
  const result = await repository.update(
    {
      id: notification.id,
      status: NotificationStatus.PENDING,
      errorMessage: token,
    },
    { updatedAt: () => 'clock_timestamp()' },
  );
  return result.affected === 1;
}

export function heartbeatPushClaim(
  repository: Repository<Notification>,
  notification: Notification,
  onError: () => void,
): () => void {
  let busy = false,
    stopped = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    void renewPushClaim(repository, notification)
      .catch(onError)
      .finally(() => {
        busy = false;
      });
  }, PUSH_CLAIM_HEARTBEAT_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    claims.delete(notification);
  };
}

export async function saveNotificationResult(
  repository: Repository<Notification>,
  notification: Notification,
): Promise<boolean> {
  const token = claims.get(notification);
  if (!token) {
    await repository.save(notification);
    return true;
  }
  const result = await repository.update(
    {
      id: notification.id,
      status: NotificationStatus.PENDING,
      errorMessage: token,
    },
    {
      status: notification.status,
      errorMessage: notification.errorMessage,
      messageId: notification.messageId,
      fcmToken: notification.fcmToken,
      data: notification.data,
      isActive: notification.isActive,
    },
  );
  return result.affected === 1;
}
