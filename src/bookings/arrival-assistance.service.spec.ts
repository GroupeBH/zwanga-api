import { ArrivalAssistanceService } from './arrival-assistance.service';
import { enqueueTransactionalNotifications } from '../notifications/transactional-notification';

jest.mock('../notifications/transactional-notification', () => ({
  enqueueTransactionalNotifications: jest.fn().mockResolvedValue(undefined),
}));

describe('arrival assistance observation and proposal', () => {
  const epoch = Date.parse('2026-11-25T08:00:00Z');
  function fixture() {
    const trip: any = {
      id: 'trip',
      status: 'ongoing',
      driverId: 'driver',
      arrivalPoint: { type: 'Point', coordinates: [15.3, -4.3] },
      currentLocation: {
        type: 'Point',
        coordinates: [15.3, -4.3 + 70 / 111195],
      },
      lastLocationUpdateAt: new Date(epoch),
      startedAt: new Date(epoch - 600000),
    };
    const booking: any = {
      id: 'booking',
      tripId: trip.id,
      passengerId: 'passenger',
      trip,
      status: 'accepted',
      pickedUp: true,
      droppedOff: false,
      pickedUpAt: new Date(epoch - 600000),
      arrivalPrompt: null,
      rideDeclarations: {},
    };
    let state: any = null;
    const redis: any = {
      get: jest.fn(async () => structuredClone(state)),
      compareAndSet: jest.fn(async (_key, previous, next) => {
        if (JSON.stringify(previous) !== JSON.stringify(state)) return false;
        state = structuredClone(next);
        return true;
      }),
    };
    const builder: any = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => booking),
    };
    const manager = {
      findOne: jest.fn(async () => trip),
      getRepository: () => ({ createQueryBuilder: () => builder }),
      query: jest.fn(async (_sql, args) => {
        booking.arrivalPrompt = JSON.parse(args[1]);
      }),
    };
    const db: any = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ArrivalAssistanceService(db, redis, {} as any);
    const observe = async (seconds: number, patch = {}) => {
      const at = epoch + seconds * 1000;
      jest.setSystemTime(at);
      trip.lastLocationUpdateAt = new Date(at);
      const point = {
        longitude: 15.3,
        latitude: -4.3 + 70 / 111195,
        accuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: null,
        recordedAt: new Date(at).toISOString(),
        ...patch,
      };
      await service.observe(booking, {
        current: point,
        previous: null,
        samples: [point],
      });
    };
    return { service, observe, db, redis, booking, trip, manager, builder };
  }
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(epoch);
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());
  it('does no SQL during five minutes, then persists one prompt with both outbox recipients', async () => {
    const f = fixture();
    for (let t = 0; t <= 300; t += 30) await f.observe(t);
    expect(f.db.transaction).not.toHaveBeenCalled();
    await f.observe(330);
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(f.manager.query).toHaveBeenCalledTimes(1);
    expect(f.builder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(enqueueTransactionalNotifications).toHaveBeenCalledWith(
      f.manager,
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'passenger',
          data: expect.objectContaining({
            type: 'arrival_confirmation_requested',
            role: 'passenger',
          }),
        }),
        expect.objectContaining({ userId: 'driver' }),
      ]),
    );
    expect(f.booking.droppedOff).toBe(false);
    expect(f.booking.status).toBe('accepted');
    await f.observe(360);
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
  });
  it('ignores duplicate fixes and resets after sparse GPS or movement', async () => {
    const f = fixture();
    for (const t of [0, 0, 0, 300, 330]) await f.observe(t);
    expect(f.db.transaction).not.toHaveBeenCalled();
    await f.observe(360, { speedMetersPerSecond: 3 });
    for (let t = 390; t <= 660; t += 30) await f.observe(t);
    expect(f.db.transaction).not.toHaveBeenCalled();
  });
  it('does not use a lost CAS claim to create a prompt', async () => {
    const f = fixture();
    for (let t = 0; t <= 300; t += 30) await f.observe(t);
    f.redis.compareAndSet.mockResolvedValueOnce(false);
    await f.observe(330);
    expect(f.db.transaction).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'droppedOff', 'dispute', 'moved'])(
    'rechecks %s under trip then booking lock',
    async (reason) => {
      const f = fixture();
      for (let t = 0; t <= 300; t += 30) await f.observe(t);
      f.db.transaction.mockImplementationOnce(async (work) => {
        if (reason === 'cancelled') f.trip.status = 'cancelled';
        if (reason === 'droppedOff') f.booking.droppedOff = true;
        if (reason === 'dispute')
          f.booking.rideDeclarations = {
            dropoff: { passenger: { decision: 'reject' } },
          };
        if (reason === 'moved')
          f.trip.currentLocation = { type: 'Point', coordinates: [16, -4] };
        return work(f.manager);
      });
      await f.observe(330);
      expect(f.manager.query).not.toHaveBeenCalled();
      expect(enqueueTransactionalNotifications).not.toHaveBeenCalled();
    },
  );
});
