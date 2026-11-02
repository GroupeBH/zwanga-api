import type { Repository } from 'typeorm';
import type { Notification } from './entities/notification.entity';
import {
  heartbeatPushClaim,
  ownPushClaim,
  renewPushClaim,
} from './notification-push-claim';

/** Renew queued rows too: a slow first send must not let another worker steal the tail. */
export async function retryPushBatch(
  repository: Repository<Notification>,
  rows: Notification[],
  deliver: (row: Notification) => Promise<boolean>,
  onError: () => void,
): Promise<number> {
  const stops = rows.map((row) => {
    ownPushClaim(row, row.errorMessage!);
    return heartbeatPushClaim(repository, row, onError);
  });
  let cursor = 0,
    delivered = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (cursor < rows.length) {
          const index = cursor++,
            row = rows[index];
          try {
            if ((await renewPushClaim(repository, row)) && (await deliver(row)))
              delivered++;
          } catch {
            onError();
          } finally {
            // Other rows proceed; the durable lease permits recovery.
            stops[index]();
          }
        }
      }),
    );
    return delivered;
  } finally {
    stops.forEach((stop) => stop());
  }
}
