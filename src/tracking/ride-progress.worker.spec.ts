import { RideProgressWorker } from './ride-progress.worker';
import { claimRideProgress, finishRideProgress } from './ride-progress-queue';
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
      .mockResolvedValueOnce([0, 1, 2, 3].map(job))
      .mockResolvedValueOnce([job(4)]);
    await f.worker.tick();
    await f.worker.tick();
    expect(claimRideProgress).toHaveBeenCalledTimes(1);
    expect(running).toBe(4);
    pending[0]();
    await flush();
    expect(
      f.bookings.evaluateAutomaticRideProgressForTrip,
    ).toHaveBeenCalledTimes(5);
    expect(maximum).toBe(4);
    const stopping = f.worker.onModuleDestroy();
    pending.slice(1).forEach((release) => release());
    await stopping;
    expect(finishRideProgress).toHaveBeenCalledTimes(5);
    expect(f.gateway.publishAutomaticProgress).toHaveBeenCalledTimes(5);
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
    expect(finishRideProgress).toHaveBeenCalledWith(f.db, job(0), true);
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
    expect(finishRideProgress).toHaveBeenCalledWith(f.db, job(0), true);
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
});
