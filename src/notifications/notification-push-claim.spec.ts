import {
  Notification,
  NotificationStatus,
} from './entities/notification.entity';
import {
  ownPushClaim,
  heartbeatPushClaim,
  saveNotificationResult,
  PUSH_CLAIM_HEARTBEAT_MS,
  PUSH_CLAIM_LEASE_MS,
} from './notification-push-claim';
import type { Repository } from 'typeorm';

describe('push worker lease', () => {
  afterEach(() => jest.useRealTimers());

  it.each([0, 1])('completes only its own pending claim, affected rows=%i', async (affected) => {
    const update = jest.fn().mockResolvedValue({ affected });
    const save = jest.fn();
    const notification = {
      id: 'synthetic', status: NotificationStatus.SENT, messageId: 'ticket', errorMessage: null,
    } as Notification;
    ownPushClaim(notification, 'claim-a');

    const completed = await saveNotificationResult(
      { update, save } as unknown as Repository<Notification>, notification,
    );

    expect(completed).toBe(affected === 1);
    expect(update).toHaveBeenCalledWith({
      id: notification.id, status: NotificationStatus.PENDING, errorMessage: 'claim-a',
    }, expect.objectContaining({ status: NotificationStatus.SENT, messageId: 'ticket', errorMessage: null }));
    expect(save).not.toHaveBeenCalled();
  });

  it('heartbeats before expiry, bounds overlapping updates and stops after completion', async () => {
    jest.useFakeTimers();
    let finish!: (value: { affected: number }) => void;
    const update = jest
      .fn<Promise<{ affected: number }>, [Record<string, unknown>, unknown]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ affected: 1 });
    const n = {
      id: 'synthetic',
      status: NotificationStatus.PENDING,
    } as Notification;
    ownPushClaim(n, 'claim-a');
    const stop = heartbeatPushClaim(
      { update } as unknown as Repository<Notification>,
      n,
      jest.fn(),
    );
    expect(PUSH_CLAIM_HEARTBEAT_MS).toBeLessThan(PUSH_CLAIM_LEASE_MS);
    expect(PUSH_CLAIM_LEASE_MS).toBeLessThan(60000);
    await jest.advanceTimersByTimeAsync(15000);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      id: n.id,
      errorMessage: 'claim-a',
      status: 'pending',
    });
    finish({ affected: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5000);
    expect(update).toHaveBeenCalledTimes(2);
    stop();
    await jest.advanceTimersByTimeAsync(60000);
    expect(update).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
