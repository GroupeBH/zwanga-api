import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BookingsService } from '../bookings/bookings.service';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { TrackingStateChangedException } from '../common/tracking-state-changed.exception';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripsService } from '../trips/trips.service';

describe('GPS conditional-write races', () => {
  const observedAt = new Date('2026-11-22T10:00:10Z');
  const older = new Date(observedAt.getTime() - 1000);
  const newer = new Date(observedAt.getTime() + 1000);
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-11-22T10:00:30Z'), doNotFake: ['setImmediate', 'clearImmediate'] }));
  afterEach(() => jest.useRealTimers());

  function fixture(passenger: boolean) {
    const trip = {
      id: 'trip',
      driverId: 'driver',
      status: TripStatus.ACTIVE,
      currentLocation: { type: 'Point', coordinates: [15.31, -4.3] },
      lastLocationUpdateAt: older,
    } as Trip;
    const booking = {
      id: 'booking',
      passengerId: 'passenger',
      tripId: trip.id,
      trip,
      status: BookingStatus.ACCEPTED,
      passengerCurrentLocation: trip.currentLocation,
      passengerLastLocationUpdateAt: older,
    } as Booking;
    const repository = {
      findOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    // Shared queued read results, distinct from conditional write results.
    repository.findOne.mockResolvedValueOnce(passenger ? booking : trip);
    repository.query.mockImplementation(async (sql: string) => sql.startsWith('SELECT')
      ? [await repository.findOne()].filter(Boolean) : []);
    const history = {
      recordDriverLocation: jest.fn(),
      recordPassengerLocation: jest.fn(),
    };
    const progress = jest
      .fn()
      .mockResolvedValue({ tripId: trip.id, events: [] });
    const service = Object.assign(
      Object.create(
        passenger ? BookingsService.prototype : TripsService.prototype,
      ),
      {
        bookingRepository: repository,
        tripRepository: repository,
        locationHistoryService: history,
        progressAfterPassengerLocation: progress,
        logger: { warn: jest.fn() },
      },
    );
    const write = () =>
      passenger
        ? service.updatePassengerLocation(
            'passenger',
            'booking',
            {
              latitude: -4.3,
              longitude: 15.32,
              recordedAt: observedAt.toISOString(),
            },
            { deferProgress: true },
          )
        : service.updateDriverLocation('driver', 'trip', [15.32, -4.3], {
            recordedAt: observedAt.toISOString(),
          });
    return { trip, booking, repository, history, progress, write };
  }

  for (const passenger of [false, true]) {
    const role = passenger ? 'passenger' : 'driver';
    it(`${role}: completion between read and write is a structured refusal, not superseded GPS`, async () => {
      const f = fixture(passenger);
      f.repository.findOne.mockResolvedValueOnce(
        passenger
          ? { ...f.booking, status: BookingStatus.COMPLETED, droppedOff: true }
          : { ...f.trip, status: TripStatus.COMPLETED },
      );
      await expect(f.write()).rejects.toMatchObject({
        constructor: TrackingStateChangedException,
        tripId: 'trip',
        ...(passenger ? { bookingId: 'booking' } : {}),
      });
      expect(f.history.recordDriverLocation).not.toHaveBeenCalled();
      expect(f.history.recordPassengerLocation).not.toHaveBeenCalled();
      expect(f.progress).not.toHaveBeenCalled();
    });

    it(`${role}: cancelled state never becomes a successful acknowledgement`, async () => {
      const f = fixture(passenger);
      f.repository.findOne.mockResolvedValueOnce(
        passenger
          ? { ...f.booking, status: BookingStatus.CANCELLED }
          : { ...f.trip, status: TripStatus.CANCELLED },
      );
      await expect(f.write()).rejects.toBeInstanceOf(BadRequestException);
      expect(f.progress).not.toHaveBeenCalled();
    });

    it(`${role}: missing or no-longer-owned record does not return stale coordinates`, async () => {
      const f = fixture(passenger);
      f.repository.findOne.mockResolvedValueOnce(null);
      await expect(f.write()).rejects.toBeInstanceOf(NotFoundException);
      expect(f.progress).not.toHaveBeenCalled();
      if (passenger) {
        const reads = f.repository.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT'));
        expect(reads).toHaveLength(2);
        for (const [sql, args] of reads) {
          expect(sql).toContain('(b.id, b."passengerId") IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))');
          expect(args).toEqual([['booking'], ['passenger']]);
        }
      }
    });

    it(`${role}: unchanged state with an older timestamp is not evidence of supersession`, async () => {
      const f = fixture(passenger);
      f.repository.findOne.mockResolvedValueOnce(
        passenger ? f.booking : f.trip,
      );
      await expect(f.write()).rejects.toBeInstanceOf(ConflictException);
      expect(f.progress).not.toHaveBeenCalled();
    });

    it(`${role}: a missing stored timestamp cannot confirm supersession`, async () => {
      const f = fixture(passenger);
      f.repository.findOne.mockResolvedValueOnce(
        passenger
          ? { ...f.booking, passengerLastLocationUpdateAt: null }
          : { ...f.trip, lastLocationUpdateAt: null },
      );
      await expect(f.write()).rejects.toBeInstanceOf(ConflictException);
      expect(f.progress).not.toHaveBeenCalled();
    });

    for (const timestamp of [observedAt, newer]) {
      it(`${role}: genuine concurrent equal/newer GPS remains superseded (${timestamp.toISOString()})`, async () => {
        const f = fixture(passenger);
        f.repository.findOne.mockResolvedValueOnce(
          passenger
            ? { ...f.booking, passengerLastLocationUpdateAt: timestamp }
            : { ...f.trip, lastLocationUpdateAt: timestamp },
        );
        await expect(f.write()).resolves.toMatchObject({
          ignoredAsOutOfOrder: true,
          updatedAt: timestamp,
        });
        expect(f.history.recordDriverLocation).not.toHaveBeenCalled();
        expect(f.history.recordPassengerLocation).not.toHaveBeenCalled();
      });
    }
  }

  it('checks driver ownership again before returning terminal state or current coordinates', async () => {
    const f = fixture(false);
    f.repository.findOne.mockResolvedValueOnce({
      ...f.trip,
      driverId: 'another-driver',
      status: TripStatus.COMPLETED,
    });
    await expect(f.write()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('checks the parent trip after a passenger write lost the race', async () => {
    const f = fixture(true);
    f.repository.findOne.mockResolvedValueOnce({
      ...f.booking,
      trip: { ...f.trip, status: TripStatus.COMPLETED },
    });
    await expect(f.write()).rejects.toBeInstanceOf(
      TrackingStateChangedException,
    );
    expect(f.progress).not.toHaveBeenCalled();
  });
});
