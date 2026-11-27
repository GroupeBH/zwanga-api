import { RideProgressWorker } from './ride-progress.worker';
import { LocationHistoryPendingError } from '../common/services/location-history.service';
import { claimRideProgress, finishRideProgress, finishAndClaimRideProgress } from './ride-progress-queue';
jest.mock('./ride-progress-queue');
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const job = (n: number) => ({
  tripId: `trip-${n}`,
  version: '1',
  leaseToken: `lease-${n}`,
});

describe('bounded durable GPS worker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(claimRideProgress).mockResolvedValue([]);
    jest.mocked(finishRideProgress).mockResolvedValue(undefined);
    jest.mocked(finishAndClaimRideProgress).mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());
  function fixture() {
    const db = { query: jest.fn().mockResolvedValue([{ tripId: 'trip' }]) };
    const bookings = { evaluateAutomaticRideProgressForTrip: jest.fn() };
    const gateway = { publishAutomaticProgress: jest.fn() };
    const worker = new RideProgressWorker(
      db as any,
      bookings as any,
      gateway as any,
    );
    return { db, bookings, gateway, worker };
  }
  it('limits concurrency to four and drains queued work as slots free, without waiting for the next cron tick', async () => {
    const f = fixture(),
      pending: Array<() => void> = [];
    let running = 0,
      maximum = 0;
    f.bookings.evaluateAutomaticRideProgressForTrip.mockImplementation(
      (tripId) =>
        new Promise((resolve) => {
          running++;
          maximum = Math.max(maximum, running);
          pending.push(() => {
            running--;
            resolve({ tripId, events: [] });
          });
        }),
    );
    jest
      .mocked(claimRideProgress)
      .mockResolvedValueOnce([0, 1, 2, 3].map(job));
    jest.mocked(finishAndClaimRideProgress).mockResolvedValueOnce(job(4));
    await f.worker.tick();
    await f.worker.tick();
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
    expect(running).toBe(4);
    pending[0]();
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(
      f.bookings.evaluateAutomaticRideProgressForTrip,
    ).toHaveBeenCalledTimes(5);
    expect(maximum).toBe(4);
    const stopping = f.worker.onModuleDestroy();
    pending.slice(1).forEach((release) => release());
    await stopping;
    expect(finishAndClaimRideProgress).toHaveBeenCalledTimes(1);
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
    expect(finishRideProgress).toHaveBeenCalledTimes(4);
    expect(f.gateway.publishAutomaticProgress).toHaveBeenCalledTimes(5);
  });
  it('hands each occupied slot to one new job without an extra claim or prefetched backlog', async () => {
    const f = fixture();
    const pending: Array<() => void> = [];
    f.bookings.evaluateAutomaticRideProgressForTrip.mockImplementation(
      tripId => new Promise(resolve => pending.push(() => resolve({ tripId, events: [] }))),
    );
    jest.mocked(claimRideProgress)
      .mockResolvedValueOnce([0, 1, 2, 3].map(job));
    for (const n of [4, 5, 6, 7]) jest.mocked(finishAndClaimRideProgress).mockResolvedValueOnce(job(n));
    await f.worker.tick();
    pending.slice().forEach(release => release());
    await flush();
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
    expect(finishAndClaimRideProgress).toHaveBeenCalledTimes(4);
    expect(pending).toHaveLength(8);
    const stopping = f.worker.onModuleDestroy();
    pending.slice(4).forEach(release => release());
    await stopping;
    expect(finishRideProgress).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not lose a free slot when work completes during a pending SQL claim', async () => {
    const f = fixture();
    const pending: Array<() => void> = [];
    let finishClaim!: (jobs: ReturnType<typeof job>[]) => void;
    f.bookings.evaluateAutomaticRideProgressForTrip.mockImplementation(
      tripId => new Promise(resolve => pending.push(() => resolve({ tripId, events: [] }))),
    );
    jest.mocked(claimRideProgress)
      .mockResolvedValueOnce([job(0), job(1)])
      .mockImplementationOnce(() => new Promise(resolve => { finishClaim = resolve; }));
    await f.worker.tick();
    const claiming = f.worker.tick();
    pending[0]();
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(claimRideProgress).toHaveBeenCalledTimes(2);
    finishClaim([job(2), job(3)]);
    await claiming;
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.mocked(claimRideProgress).mock.calls.map(args => args[1])).toEqual([4, 2, 1]);
    const stopping = f.worker.onModuleDestroy();
    pending.slice(1).forEach(release => release());
    await stopping;
    expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels a scheduled refill on shutdown without discarding already claimed work', async () => {
    const f = fixture();
    jest.mocked(claimRideProgress).mockResolvedValueOnce([job(0)]);
    f.bookings.evaluateAutomaticRideProgressForTrip.mockResolvedValue({ tripId: 'trip-0', events: [] });
    await f.worker.tick();
    await flush();
    await f.worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(0);
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
    expect(finishAndClaimRideProgress).toHaveBeenCalledWith(f.db, job(0), false, 5000);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not spin on an empty queue or a failed claim and allows the recovery cron', async () => {
    const f = fixture();
    jest.mocked(claimRideProgress).mockRejectedValueOnce(new Error('database unavailable'));
    await f.worker.tick();
    await jest.advanceTimersByTimeAsync(1000);
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
    await f.worker.tick();
    await jest.advanceTimersByTimeAsync(1000);
    expect(claimRideProgress).toHaveBeenCalledTimes(2);
    await f.worker.onModuleDestroy();
  });
  it('retains failed work for durable retry and never emits uncommitted progress', async () => {
    const f = fixture();
    jest.mocked(claimRideProgress).mockResolvedValueOnce([job(0)]);
    f.bookings.evaluateAutomaticRideProgressForTrip.mockRejectedValue(
      new Error('transaction failed'),
    );
    await f.worker.tick();
    await flush();
    await f.worker.onModuleDestroy();
    expect(finishAndClaimRideProgress).toHaveBeenCalledWith(f.db, job(0), true, 5000);
    expect(f.gateway.publishAutomaticProgress).not.toHaveBeenCalled();
  });
  it('renews long work and does not publish after losing ownership', async () => {
    const f = fixture();
    let finish!: (value: any) => void;
    jest.mocked(claimRideProgress).mockResolvedValueOnce([job(0)]);
    f.bookings.evaluateAutomaticRideProgressForTrip.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await f.worker.tick();
    f.db.query.mockResolvedValue([]);
    await jest.advanceTimersByTimeAsync(20000);
    finish({ tripId: 'trip-0', events: [{}] });
    await flush();
    await f.worker.onModuleDestroy();
    expect(f.db.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT "tripId" FROM renewed'),
      ['trip-0', 'lease-0'],
    );
    expect(finishAndClaimRideProgress).toHaveBeenCalledWith(f.db, job(0), true, 5000);
    expect(f.gateway.publishAutomaticProgress).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('shutdown waits for an outstanding database claim and its processing', async () => {
    const f = fixture();
    let claim!: (value: any) => void, finish!: (value: any) => void;
    jest.mocked(claimRideProgress).mockReturnValueOnce(
      new Promise((resolve) => {
        claim = resolve;
      }),
    );
    f.bookings.evaluateAutomaticRideProgressForTrip.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const ticking = f.worker.tick();
    let stopped = false;
    const stopping = f.worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    claim([job(0)]);
    await ticking;
    await flush();
    expect(stopped).toBe(false);
    finish({ tripId: 'trip-0', events: [] });
    await stopping;
    await f.worker.tick();
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
  });
  it('retains the durable job while committed GPS history catches up, without publishing progress', async () => {
    const f = fixture();
    jest.mocked(claimRideProgress).mockResolvedValueOnce([job(0)]);
    f.bookings.evaluateAutomaticRideProgressForTrip.mockRejectedValue(new LocationHistoryPendingError());
    await f.worker.tick();
    await flush();
    await f.worker.onModuleDestroy();
    expect(f.bookings.evaluateAutomaticRideProgressForTrip).toHaveBeenCalledWith('trip-0', {
      checkProximity: true, requireRecordedHistory: true,
    });
    expect(finishAndClaimRideProgress).toHaveBeenCalledWith(f.db, job(0), true, 1000);
    expect(f.gateway.publishAutomaticProgress).not.toHaveBeenCalled();
  });
  it('releases a handoff received during shutdown without evaluating it or erasing its durable work', async () => {
    const f = fixture();
    let completeHandoff!: (value: ReturnType<typeof job>) => void;
    jest.mocked(claimRideProgress).mockResolvedValueOnce([job(0)]);
    f.bookings.evaluateAutomaticRideProgressForTrip.mockResolvedValue({ tripId: 'trip-0', events: [] });
    jest.mocked(finishAndClaimRideProgress).mockImplementationOnce(() => new Promise(resolve => { completeHandoff = resolve; }));
    await f.worker.tick(); await flush();
    let stopped = false;
    const stopping = f.worker.onModuleDestroy().then(() => { stopped = true; });
    await flush(); expect(stopped).toBe(false);
    completeHandoff(job(1)); await stopping;
    expect(finishRideProgress).toHaveBeenCalledWith(f.db, job(1), true, 1000);
    expect(f.bookings.evaluateAutomaticRideProgressForTrip).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not retry an ambiguous failed handoff and lets durable lease recovery handle it', async () => {
    const f = fixture();
    jest.mocked(claimRideProgress).mockResolvedValueOnce([job(0)]);
    f.bookings.evaluateAutomaticRideProgressForTrip.mockResolvedValue({ tripId: 'trip-0', events: [] });
    jest.mocked(finishAndClaimRideProgress).mockRejectedValueOnce(new Error('connection lost after commit'));
    await f.worker.tick(); await flush(); await f.worker.onModuleDestroy();
    expect(finishAndClaimRideProgress).toHaveBeenCalledTimes(1);
    expect(finishRideProgress).not.toHaveBeenCalled();
    expect(f.bookings.evaluateAutomaticRideProgressForTrip).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
