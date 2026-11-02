import { FirebaseDeliveryError } from './firebase-delivery-error';
import { recordPushFailure, urgentPushWorkers } from './push-retry-policy';
import { firebaseRetryAfter } from './bounded-firebase-send';
import type { Notification } from './entities/notification.entity';

describe('durable push retry policy', () => {
  it('honors 429/503 Retry-After, HTTP dates, and conservative malformed quota headers', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(firebaseRetryAfter('120', 429, now)).toBe(now + 120000);
    expect(
      firebaseRetryAfter(new Date(now + 90000).toUTCString(), 503, now),
    ).toBe(now + 90000);
    expect(firebaseRetryAfter('-1', 429, now)).toBe(now + 60000);
    expect(firebaseRetryAfter(null, 503, now)).toBeUndefined();
    const n = {} as Notification;
    recordPushFailure(
      n,
      new FirebaseDeliveryError('FCM_HTTP_429', {
        code: 'quota',
        phase: 'send',
        transient: true,
        retryAt: now + 120000,
      }),
      now,
      () => 0,
    );
    expect(n.pushRetryAt!.getTime()).toBe(now + 120000);
    expect(n.pushAttempts).toBe(1);
    recordPushFailure(n, undefined, now, () => 1);
    expect(n.pushRetryAt!.getTime()).toBe(now + 37500);
  });
  it('stops permanent failures and caps repeated transient backoff', () => {
    const n = {} as Notification;
    recordPushFailure(
      n,
      new FirebaseDeliveryError('invalid', {
        code: 'invalid',
        phase: 'send',
        transient: false,
      }),
      1000,
      () => 0,
    );
    expect(n.pushPermanentFailure).toBe(true);
    for (let i = 0; i < 100; i++)
      recordPushFailure(n, undefined, 1000, () => 1);
    expect(n.pushPermanentFailure).toBe(false);
    expect(n.pushRetryAt!.getTime()).toBeLessThanOrEqual(1000 + 1125000);
  });
  it.each([
    [undefined, 8],
    ['NaN', 8],
    [0, 8],
    ['4', 4],
    [200, 20],
  ])('bounds worker setting %s to %s', (value, expected) => {
    expect(urgentPushWorkers(value)).toBe(expected);
  });
});
