import { DataSource } from 'typeorm';
import { TripsService } from '../src/trips/trips.service';
import { Trip, TripStatus } from '../src/trips/entities/trip.entity';
import {
  TripRequest,
  TripRequestStatus,
} from '../src/trip-requests/entities/trip-request.entity';
import { User } from '../src/users/entities/user.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { assertDriverRequestSchedule } from '../src/trip-requests/dispatch/driver-schedule-policy';
import { saveTripDetailsUpdate } from '../src/trips/save-trip-details-update';

// Actual service + repositories on the existing disposable PostGIS fixture.
// External geocoding/notifications are never requested by these date-only edits.
export function tripUpdateSchedulePostgresTests(
  get: () => {
    source: DataSource;
    driver: () => Promise<{ user: User; vehicle: Vehicle }>;
    request: (immediate?: boolean) => Promise<TripRequest>;
  },
) {
  describe('trip detail schedule', () => {
    const at = (hours: number) => new Date(Date.now() + hours * 3600000);
    const setup = async () => {
      const { source, driver, request } = get();
      const d = await driver(),
        wanted = await request(false);
      wanted.departureDateMin = at(1);
      wanted.departureDateMax = at(1.5);
      await source.getRepository(TripRequest).save(wanted);
      const trips = source.getRepository(Trip);
      const trip = await trips.save({
        driverId: d.user.id,
        vehicleId: d.vehicle.id,
        isPrivate: false,
        status: TripStatus.PENDING,
        departureDate: at(6),
        estimatedArrivalDate: at(7),
        departureLocation: 'Départ de test',
        arrivalLocation: 'Arrivée de test',
        totalSeats: 4,
        availableSeats: 4,
        pricePerSeat: 1000,
      });
      const cache = { del: jest.fn().mockResolvedValue(undefined) };
      const service: TripsService = Object.assign(
        Object.create(TripsService.prototype),
        {
          tripRepository: trips,
          vehicleRepository: source.getRepository(Vehicle),
          cacheService: cache,
          logger: { log() {}, warn() {}, error() {} },
          findOne: (id: string) => trips.findOneByOrFail({ id }),
        },
      );
      const update = (hours: number) =>
        service.update(trip.id, d.user.id, {
          departureDate: at(hours).toISOString(),
        });
      const accept = () =>
        source.transaction('READ COMMITTED', async (tx) => {
          await tx.getRepository(TripRequest).findOne({
            where: { id: wanted.id },
            lock: { mode: 'pessimistic_write' },
          });
          await assertDriverRequestSchedule(tx, d.user.id, wanted.id);
          await tx.getRepository(TripRequest).update(wanted.id, {
            status: TripRequestStatus.DRIVER_SELECTED,
            selectedDriverId: d.user.id,
          });
        });
      return {
        source,
        d,
        wanted,
        trips,
        trip,
        service,
        cache,
        update,
        accept,
        request,
      };
    };

    it('rejects a public trip moved over an accepted request without saving or notifying', async () => {
      const f = await setup();
      await f.accept();
      await expect(f.update(1)).rejects.toMatchObject({
        response: { code: 'DRIVER_SCHEDULE_CONFLICT' },
      });
      expect(
        (await f.trips.findOneByOrFail({ id: f.trip.id })).departureDate,
      ).toEqual(f.trip.departureDate);
      expect(f.cache.del).not.toHaveBeenCalled();
    });

    it('allows a compatible public edit and preserves its estimated duration', async () => {
      const f = await setup();
      await f.accept();
      const updated = await f.update(8);
      expect(updated.departureDate.getTime()).toBeGreaterThan(
        f.trip.departureDate.getTime(),
      );
      expect(
        updated.estimatedArrivalDate!.getTime() -
          updated.departureDate.getTime(),
      ).toBe(
        f.trip.estimatedArrivalDate!.getTime() - f.trip.departureDate.getTime(),
      );
      expect(f.cache.del).toHaveBeenCalled();
    });

    it('does not shorten a known duration when moving a departure later', async () => {
      const f = await setup();
      await f.source.getRepository(TripRequest).update(f.wanted.id, {
        departureDateMin: at(8.4),
        departureDateMax: at(8.9),
      });
      await f.accept(); // Original public trip finishes at 7h, transfer ends at 7.5h.
      await expect(f.update(6.95)).rejects.toMatchObject({
        response: { code: 'DRIVER_SCHEDULE_CONFLICT' },
      });
      // Keeping the old 7h arrival would have incorrectly allowed this edit.
    });

    it('allows a private course to move without conflicting with its own selected request', async () => {
      const f = await setup();
      await f.trips.update(f.trip.id, {
        isPrivate: true,
        tripRequestId: f.wanted.id,
      });
      await f.source.getRepository(TripRequest).update(f.wanted.id, {
        status: TripRequestStatus.DRIVER_SELECTED,
        selectedDriverId: f.d.user.id,
        tripId: f.trip.id,
      });
      await expect(f.update(1)).resolves.toMatchObject({
        id: f.trip.id,
        tripRequestId: f.wanted.id,
      });
    });

    it('checks public courses too when the edited trip belongs to a request', async () => {
      const f = await setup();
      await f.trips.update(f.trip.id, {
        isPrivate: true,
        tripRequestId: f.wanted.id,
      });
      await f.trips.save({
        ...f.trip,
        id: undefined,
        departureDate: at(1),
        estimatedArrivalDate: at(2),
      });
      await expect(f.update(1)).rejects.toMatchObject({
        response: { code: 'DRIVER_SCHEDULE_CONFLICT' },
      });
    });

    it('preserves the existing public/public policy', async () => {
      const f = await setup();
      await f.trips.save({
        ...f.trip,
        id: undefined,
        departureDate: at(1),
        estimatedArrivalDate: at(2),
      });
      await expect(f.update(1)).resolves.toMatchObject({ id: f.trip.id });
    });

    it.each([false, true])(
      'serializes an actual update and acceptance (compatible=%s)',
      async (compatible) => {
        const f = await setup();
        const results = await Promise.allSettled([
          f.update(compatible ? 8 : 1),
          f.accept(),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
          compatible ? 2 : 1,
        );
        if (!compatible)
          expect(results.find((r) => r.status === 'rejected')).toMatchObject({
            reason: { response: { code: 'DRIVER_SCHEDULE_CONFLICT' } },
          });
      },
    );

    it('rejects a later acceptance after the conflicting edit has committed', async () => {
      const f = await setup();
      await f.update(1);
      await expect(f.accept()).rejects.toMatchObject({
        response: { code: 'DRIVER_SCHEDULE_CONFLICT' },
      });
    });

    it('rechecks conflicts when a finished trip is made upcoming without changing the time', async () => {
      const f = await setup();
      await f.trips.update(f.trip.id, {
        status: TripStatus.COMPLETED,
        departureDate: f.wanted.departureDateMin,
        estimatedArrivalDate: null,
      });
      await f.accept();
      await expect(
        f.service.update(f.trip.id, f.d.user.id, {
          status: TripStatus.PENDING,
        }),
      ).rejects.toMatchObject({
        response: { code: 'DRIVER_SCHEDULE_CONFLICT' },
      });
      expect((await f.trips.findOneByOrFail({ id: f.trip.id })).status).toBe(
        TripStatus.COMPLETED,
      );
    });

    it('rejects an edit over a linked private course as well as an unlinked selected request', async () => {
      const f = await setup();
      await f.trips.save({
        ...f.trip,
        id: undefined,
        isPrivate: true,
        tripRequestId: f.wanted.id,
        departureDate: at(1),
        estimatedArrivalDate: at(2),
      });
      await expect(f.update(1)).rejects.toMatchObject({
        response: { code: 'DRIVER_SCHEDULE_CONFLICT' },
      });
    });

    it('does not undo a newly validated schedule when an older description edit completes', async () => {
      const f = await setup();
      const before = await f.trips.findOneByOrFail({ id: f.trip.id });
      await f.update(8);
      const saved = await saveTripDetailsUpdate(f.trips, before, {
        ...before,
        description: 'Repère précisé',
      });
      expect(saved.departureDate.getTime()).toBeGreaterThan(
        before.departureDate.getTime(),
      );
      expect(saved.description).toBe('Repère précisé');
    });

    it('preserves a concurrent seat reservation and rejects stale seat recalculation', async () => {
      const f = await setup();
      const before = await f.trips.findOneByOrFail({ id: f.trip.id });
      await f.trips.update(f.trip.id, { availableSeats: 3 });
      const saved = await saveTripDetailsUpdate(f.trips, before, {
        ...before,
        departureDate: at(8),
      });
      expect(saved.availableSeats).toBe(3);
      await expect(
        saveTripDetailsUpdate(f.trips, before, {
          ...before,
          totalSeats: 5,
          availableSeats: 5,
        }),
      ).rejects.toMatchObject({ response: { code: 'TRIP_CHANGED' } });
    });
  });
}
