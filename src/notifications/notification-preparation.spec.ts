import { NotificationPreparation } from './notification-preparation';
import { NotificationService } from './notifications.service';
import { NotificationStatus } from './entities/notification.entity';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('bounded notification SQL preparation', () => {
  it('keeps FIFO order, releases failures and gives realtime independent capacity', async () => {
    const gate = new NotificationPreparation();
    const jobs = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    let active = 0, peak = 0;
    const pending = jobs.map((job, i) => gate.run('urgent', async () => {
      started.push(i); active++; peak = Math.max(peak, active);
      try { await job.promise; } finally { active--; }
    }).catch(error => error.message));
    await flush();
    expect(started).toEqual([0, 1]);
    await expect(gate.run('realtime', async () => 'independent')).resolves.toBe('independent');
    jobs[0].reject(new Error('storage failure')); await flush();
    expect(started).toEqual([0, 1, 2]);
    for (const job of jobs.slice(1)) { job.resolve(); await flush(); }
    expect((await Promise.all(pending))[0]).toBe('storage failure');
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    await expect(gate.run('urgent', async () => 'recovered')).resolves.toBe('recovered');
  });

  function fixture() {
    const repository = { save: jest.fn(async n => n), update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: { query: jest.fn().mockResolvedValue([{}]) } };
    const service: any = Object.assign(Object.create(NotificationService.prototype), {
      notificationRepository: repository,
      userRepository: { query: jest.fn().mockResolvedValue([
        { id: 'user', fcmToken: 'token', hasExclusivePushToken: true },
      ]) },
      logger: { warn: jest.fn(), debug: jest.fn(), log: jest.fn(), error: jest.fn() },
      sendFirebaseNotification: jest.fn().mockResolvedValue('synthetic'),
    });
    const notice = (id: string, type = 'booking_response') => ({ id, userId: 'user', isActive: true,
      fcmToken: 'old-token', data: { type }, status: NotificationStatus.PENDING });
    return { service, repository, notice };
  }

  it('does not hold SQL admission across slow push HTTP', async () => {
    const f = fixture();
    const relevant = jest.spyOn(f.service, 'isCriticalNotificationStillDeliverable').mockResolvedValue(true);
    const http = deferred<string>();
    f.service.sendFirebaseNotification.mockReturnValue(http.promise);
    const pending = Array.from({ length: 8 }, (_, i) => f.service.deliverSavedNotification(f.notice(String(i)), true));
    await flush();
    expect(f.service.sendFirebaseNotification).toHaveBeenCalledTimes(8);
    expect(relevant).toHaveBeenCalledTimes(8);
    await expect(f.service.prepareInLane('realtime', async () => 'available')).resolves.toBe('available');
    http.resolve('synthetic'); await Promise.all(pending);
  });

  it('rechecks queued invitations after admission and suppresses a cancellation while waiting', async () => {
    const f = fixture();
    let cancelled = false;
    const blocker = deferred();
    const relevant = jest.spyOn(f.service, 'isCriticalNotificationStillDeliverable').mockImplementation(async (n: any) => {
      if (n.id === '0' || n.id === '1') await blocker.promise;
      return n.id !== '2' || !cancelled;
    });
    const pending = [0, 1, 2].map(i => f.service.deliverSavedNotification(f.notice(String(i)), true));
    await flush();
    expect(relevant).toHaveBeenCalledTimes(2);
    cancelled = true; blocker.resolve();
    expect(await Promise.all(pending)).toEqual([true, true, false]);
    expect(f.service.sendFirebaseNotification.mock.calls.map(([n]: any[]) => n.id)).toEqual(['0', '1']);
    expect(f.repository.save).toHaveBeenCalledWith(expect.objectContaining({ id: '2', isActive: false }));
  });

  it('checks automatic ride relevance only once, on every independent send attempt', async () => {
    const f = fixture();
    const data = { type: 'pickup_confirmed_automatically',
      bookingId: '00000000-0000-4000-8000-000000000001', tripId: '00000000-0000-4000-8000-000000000002' };
    const notice = { ...f.notice('pickup'), data };
    await expect(f.service.deliverSavedNotification(notice, true)).resolves.toBe(true);
    expect(f.repository.manager.query).toHaveBeenCalledTimes(1);
    f.repository.manager.query.mockResolvedValue([]);
    await expect(f.service.deliverSavedNotification(notice, true)).resolves.toBe(false);
    expect(f.repository.manager.query).toHaveBeenCalledTimes(2);
    expect(f.service.sendFirebaseNotification).toHaveBeenCalledTimes(1);
  });
});
