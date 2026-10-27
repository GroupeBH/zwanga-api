import type { Notification } from './entities/notification.entity';
import {
  androidDriverBackup,
  androidDriverBackupTtl,
} from './android-driver-backup';

/** v6 is registered only by a binary with the native Notifee receiver. */
export function nativeAndroidDriverPush(
  notification: Notification,
  token: string,
  ringUntil: string,
) {
  const nearby = notification.data?.type === 'trip_request_nearby';
  const data = androidDriverBackup(notification, {
    ...notification.data,
    notificationId: notification.id,
    nativeAlert: 'driver-v6',
    ringUntil,
    ...(nearby
      ? { delivery: 'driver-phone-v3' }
      : { actionProtocol: 'driver-v1', ringVersion: 'v2' }),
  });
  const payload = Object.fromEntries(
    Object.entries({ ...data, nativeAlert: 'driver-v6' }).map(
      ([key, value]) => [key, String(value)],
    ),
  );
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 4000)
    throw new Error('DRIVER_ALERT_PAYLOAD_TOO_LARGE');
  return {
    token,
    data: payload,
    android: {
      priority: 'high' as const,
      ttl: androidDriverBackupTtl(notification),
    },
  };
}
