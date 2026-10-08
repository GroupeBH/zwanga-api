import { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  Notification,
  NotificationStatus,
} from './entities/notification.entity';

export interface TransactionalNotification {
  eventKey: string;
  userId: string;
  title: string;
  body: string;
  data: Record<string, string | number | boolean | null>;
}

/** Use the business transaction's manager. No push/network call before COMMIT. */
export async function enqueueTransactionalNotification(
  manager: EntityManager,
  notification: TransactionalNotification,
): Promise<void> {
  await manager
    .createQueryBuilder()
    .insert()
    .into(Notification)
    .values({
      ...notification,
      // TypeORM's recursive partial does not model nullable JSON scalar values.
      data: notification.data as unknown as QueryDeepPartialEntity<Notification>['data'],
      fcmToken: '', // Resolved just before delivery, including after a device change.
      isAutomatic: false,
      status: NotificationStatus.PENDING,
      errorMessage: null,
    })
    .onConflict('("eventKey") DO NOTHING')
    .execute();
}

export function displayAmount(
  amount: number | string,
  currency: string,
): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(Math.abs(Number(amount)))} ${currency === 'PTS' ? 'jetons' : currency}`;
}
