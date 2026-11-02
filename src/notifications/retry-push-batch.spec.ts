import { retryPushBatch } from './retry-push-batch';
import {
  isRetryPushClaim,
  saveNotificationResult,
} from './notification-push-claim';
import {
  Notification,
  NotificationStatus,
} from './entities/notification.entity';
import type { Repository } from 'typeorm';

const row = (id: string) =>
  ({
    id,
    status: NotificationStatus.PENDING,
    errorMessage: `CRITICAL_PUSH_RETRY_CLAIMED:${id}`,
  }) as Notification;

describe('critical push retry ownership', () => {
  afterEach(() => jest.useRealTimers());

  it('renews waiting rows, limits concurrency to five and prevents an old result from overwriting a new claim', async () => {
    jest.useFakeTimers();
    const rows = Array.from({ length: 7 }, (_, index) => row(String(index)));
    const owners = new Map(rows.map((item) => [item.id, item.errorMessage]));
    const update = jest.fn((where: { id: string; errorMessage: string }) =>
      Promise.resolve({
        affected: owners.get(where.id) === where.errorMessage ? 1 : 0,
      }),
    );
    const save = jest.fn(),
      repo = { update, save } as unknown as Repository<Notification>;
    const releases: (() => void)[] = [];
    const results: boolean[] = [];
    let active = 0,
      peak = 0;
    const deliver = jest.fn(async (item: Notification) => {
      expect(isRetryPushClaim(item)).toBe(true);
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      item.status = NotificationStatus.SENT;
      item.errorMessage = null;
      const saved = await saveNotificationResult(repo, item);
      results.push(saved);
      active--;
      return saved;
    });
    const work = retryPushBatch(repo, rows, deliver, jest.fn());
    await jest.advanceTimersByTimeAsync(5000);
    expect(deliver).toHaveBeenCalledTimes(5);
    expect(update.mock.calls.some(([where]) => where.id === '6')).toBe(true);
    owners.set('0', 'replacement-worker');
    owners.set('6', 'replacement-worker');
    releases.splice(0).forEach((resolve) => resolve());
    await jest.advanceTimersByTimeAsync(0);
    releases.splice(0).forEach((resolve) => resolve());
    expect(await work).toBe(5);
    expect(peak).toBe(5);
    expect(results).toContain(false);
    expect(deliver.mock.calls.some(([item]) => item.id === '6')).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('isolates errors and always releases heartbeats', async () => {
    jest.useFakeTimers();
    const repo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as Repository<Notification>;
    const failure = jest.fn();
    const count = await retryPushBatch(
      repo,
      [row('a'), row('b')],
      (item) =>
        item.id === 'a'
          ? Promise.reject(new Error('synthetic outage'))
          : Promise.resolve(true),
      failure,
    );
    expect(count).toBe(1);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
