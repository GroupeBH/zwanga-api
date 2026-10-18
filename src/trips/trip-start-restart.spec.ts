import { BadRequestException, Logger } from '@nestjs/common';
import { TripsService } from './trips.service';
import { TripStatus } from './entities/trip.entity';
import { BookingStatus } from '../bookings/entities/booking.entity';

const firstStart = new Date('2026-10-10T10:00:00.000Z');

function fixture(overrides: Record<string, unknown> = {}) {
  const saved: any = { id: 'trip-test', driverId: 'driver-test', status: TripStatus.PENDING,
    startedAt: null, availableSeats: 0, bookings: [], currentLocation: null,
    lastLocationUpdateAt: null, ...overrides };
  const service: any = Object.create(TripsService.prototype);
  service.logger = new Logger('TripStartTest');
  const repo = {
    findOne: jest.fn(async ({ where }) => where.id === saved.id && where.driverId === saved.driverId ? { ...saved } : null),
    save: jest.fn(async (trip) => Object.assign(saved, trip)),
    update: jest.fn(async (where, updates) => {
      // Exercise the same NULL/non-NULL and state guards as the repository update.
      const matchesStart = where.startedAt.type === 'isNull' ? saved.startedAt === null : saved.startedAt !== null;
      if (where.id !== saved.id || where.driverId !== saved.driverId || saved.status !== where.status || !matchesStart) return { affected: 0 };
      Object.assign(saved, updates); return { affected: 1 };
    }),
  };
  service.tripRepository = repo;
  service.bookingRepository = { find: jest.fn(async () => saved.bookings) };
  service.ensureDriverCanStartTrip = jest.fn(async () => undefined);
  service.calculateEstimatedArrivalDate = jest.fn(async (_trip, time) => new Date(time.getTime() + 1800000));
  service.findOne = jest.fn(async () => ({ ...saved }));
  service.cacheService = { del: jest.fn(async () => undefined) };
  service.logTripStateChange = jest.fn();
  service.notifyDriverEmergencyContacts = jest.fn(async () => undefined);
  service.notifyBookedPassengersAboutTripStart = jest.fn(async () => undefined);
  service.notifyNearbyUsersAboutTripStart = jest.fn(async () => undefined);
  service.notifyPassengersAboutTripPause = jest.fn(async () => undefined);
  service.invalidateDriverInterruptionCaches = jest.fn(async () => undefined);
  const resume = jest.fn(async () => false);
  jest.spyOn(service, 'driverInterruptionWorkflow', 'get').mockReturnValue({ resume });
  return { service, repo, saved, resume, start: () => service.startTrip(saved.id, saved.driverId) };
}

afterEach(() => jest.restoreAllMocks());

it('starts a new pending ride once and resets only its initial tracking state', async () => {
  const f = fixture({ currentLocation: { type: 'Point', coordinates: [15.3, -4.3] } });
  const result = await f.start();
  expect(result.status).toBe(TripStatus.ACTIVE);
  expect(result.startedAt).toBeInstanceOf(Date);
  expect(result.currentLocation).toBeNull();
  expect(f.repo.update.mock.calls[0][0].startedAt.type).toBe('isNull');
  expect(f.service.ensureDriverCanStartTrip).toHaveBeenCalledWith('driver-test', 'trip-test');
  expect(f.service.notifyDriverEmergencyContacts).toHaveBeenCalledTimes(1);
});

it('resumes after a direct pause before pickup, preserving the original start and location', async () => {
  const point = { type: 'Point', coordinates: [15.3, -4.3] };
  const f = fixture({ status: TripStatus.ACTIVE, startedAt: firstStart, currentLocation: point, lastLocationUpdateAt: firstStart });
  await f.service.pauseTrip('trip-test', 'driver-test');
  expect(f.saved.status).toBe(TripStatus.PENDING);
  expect(f.saved.startedAt).toEqual(firstStart);
  const resumed = await f.start();
  expect(resumed.status).toBe(TripStatus.ACTIVE);
  expect(resumed.startedAt).toEqual(firstStart);
  expect(resumed.currentLocation).toEqual(point);
  expect(resumed.lastLocationUpdateAt).toEqual(firstStart);
  expect(f.repo.update.mock.calls[0][0].startedAt.type).toBe('not');
  expect(f.repo.update.mock.calls[0][1]).not.toHaveProperty('startedAt');
  expect(f.service.calculateEstimatedArrivalDate.mock.calls[0][1].getTime()).toBeGreaterThan(firstStart.getTime());
});

it('returns an already active owned ride without starting or notifying again', async () => {
  const f = fixture({ status: TripStatus.ACTIVE, startedAt: firstStart });
  expect((await f.start()).status).toBe(TripStatus.ACTIVE);
  expect(f.repo.update).not.toHaveBeenCalled();
  expect(f.service.calculateEstimatedArrivalDate).not.toHaveBeenCalled();
  expect(f.service.notifyDriverEmergencyContacts).not.toHaveBeenCalled();
  expect(f.service.cacheService.del).toHaveBeenCalledTimes(1);
});

it('two concurrent starts produce one state transition and one notification sequence', async () => {
  const f = fixture();
  const result = await Promise.all([f.start(), f.start()]);
  expect(result.every(trip => trip.status === TripStatus.ACTIVE)).toBe(true);
  expect(f.service.logTripStateChange).toHaveBeenCalledTimes(1);
  expect(f.service.notifyDriverEmergencyContacts).toHaveBeenCalledTimes(1);
  expect(f.service.notifyBookedPassengersAboutTripStart).toHaveBeenCalledTimes(1);
});

it('does not bypass a formal interruption awaiting passenger decisions', async () => {
  const f = fixture({ startedAt: firstStart });
  f.resume.mockRejectedValue(new BadRequestException('Attendez les passagers.'));
  await expect(f.start()).rejects.toThrow('Attendez les passagers');
  expect(f.repo.update).not.toHaveBeenCalled();
  expect(f.service.notifyDriverEmergencyContacts).not.toHaveBeenCalled();
});

it('keeps the existing confirmed-interruption workflow', async () => {
  const f = fixture({ startedAt: firstStart });
  f.resume.mockImplementation(async () => { f.saved.status = TripStatus.ACTIVE; return true; });
  expect((await f.start()).status).toBe(TripStatus.ACTIVE);
  expect(f.repo.update).not.toHaveBeenCalled();
  expect(f.service.invalidateDriverInterruptionCaches).toHaveBeenCalledTimes(1);
});

it('cannot silently resume a legacy paused ride with a passenger still onboard', async () => {
  const f = fixture({ startedAt: firstStart, bookings: [{ status: BookingStatus.ACCEPTED, pickedUp: true }] });
  await expect(f.start()).rejects.toThrow('passagers à bord');
  expect(f.repo.update).not.toHaveBeenCalled();
});

for (const status of [TripStatus.CANCELLED, TripStatus.COMPLETED]) {
  it(`never reactivates a ${status} ride`, async () => {
    const f = fixture({ status, startedAt: firstStart });
    await expect(f.start()).rejects.toThrow('Impossible de démarrer');
    expect(f.repo.update).not.toHaveBeenCalled();
  });
}

it('a concurrent cancellation remains terminal and returns a recognizable conflict', async () => {
  const f = fixture();
  f.repo.update.mockImplementation(async () => { f.saved.status = TripStatus.CANCELLED; return { affected: 0 }; });
  await expect(f.start()).rejects.toMatchObject({ response: { code: 'TRIP_START_STATE_CHANGED' } });
  expect(f.saved.status).toBe(TripStatus.CANCELLED);
  expect(f.service.notifyDriverEmergencyContacts).not.toHaveBeenCalled();
});

it('an unauthorized caller cannot read or restart the ride, even if already active', async () => {
  const f = fixture({ status: TripStatus.ACTIVE, startedAt: firstStart });
  await expect(f.service.startTrip('trip-test', 'someone-else')).rejects.toThrow('conducteur');
  expect(f.repo.update).not.toHaveBeenCalled();
  expect(f.service.findOne).not.toHaveBeenCalled();
});
