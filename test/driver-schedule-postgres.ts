import { DataSource } from 'typeorm';
import { Trip, TripStatus } from '../src/trips/entities/trip.entity';
import {
  TripRequest,
  TripRequestStatus,
} from '../src/trip-requests/entities/trip-request.entity';
import { User } from '../src/users/entities/user.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { sequentialCandidates } from '../src/trip-requests/dispatch/sequential-candidates';
import {
  assertDriverRequestSchedule,
  assertPublicationRequestSchedule,
} from '../src/trip-requests/dispatch/driver-schedule-policy';
import { requestSearchMap } from '../src/trip-requests/request-search-map';
import { savePublicationsWithPhotoPolicy } from '../src/trips/trip-publication-photo';

// Reuses only the disposable PostgreSQL/PostGIS fixture, never application data.
export function driverSchedulePostgresTests(
  get: () => {
    source: DataSource;
    driver: (longitude?: number) => Promise<{ user: User; vehicle: Vehicle }>;
    request: (immediate?: boolean) => Promise<TripRequest>;
  },
) {
  const at = (hours: number) => new Date(Date.now() + hours * 3600000);
  const move = async (
    source: DataSource,
    request: TripRequest,
    hours: number,
  ) => {
    request.departureDateMin = at(hours);
    request.departureDateMax = at(hours + 0.5);
    await source.getRepository(TripRequest).save(request);
  };
  const tripData = (
    driverId: string,
    requestId: string,
    status = TripStatus.PENDING,
  ) => ({
    driverId,
    tripRequestId: requestId,
    isPrivate: true,
    status,
    departureDate: at(1),
    departureLocation: 'Fixture',
    arrivalLocation: 'Fixture',
    totalSeats: 4,
    availableSeats: 4,
    pricePerSeat: 1000,
  });

  it('offers a request despite an accepted course six hours later, but excludes overlapping schedules', async () => {
    const { source, driver, request } = get();
    const d = await driver(),
      wanted = await request(false),
      assigned = await request(false);
    await move(source, assigned, 6);
    await source.getRepository(TripRequest).update(assigned.id, {
      status: TripRequestStatus.DRIVER_SELECTED,
      selectedDriverId: d.user.id,
    });
    expect(
      (await sequentialCandidates(source.manager, wanted)).map(
        (c) => c.driverId,
      ),
    ).toContain(d.user.id);
    expect(
      (await requestSearchMap(source.manager, wanted.passengerId, wanted.id))
        .total,
    ).toBe(1);
    await move(source, assigned, 1);
    // Keep the selected state when moving the fixture's date.
    await source.getRepository(TripRequest).update(assigned.id, {
      status: TripRequestStatus.DRIVER_SELECTED,
      selectedDriverId: d.user.id,
    });
    expect(await sequentialCandidates(source.manager, wanted)).toHaveLength(0);
    expect(
      (await requestSearchMap(source.manager, wanted.passengerId, wanted.id))
        .total,
    ).toBe(0);
  });

  it.each([TripStatus.COMPLETED, TripStatus.CANCELLED])(
    'a linked %s trip no longer leaves its selected request blocking alerts',
    async (status) => {
      const { source, driver, request } = get();
      const d = await driver(),
        wanted = await request(false),
        assigned = await request(false);
      const trip = await source
        .getRepository(Trip)
        .save(tripData(d.user.id, assigned.id, status));
      await source.getRepository(TripRequest).update(assigned.id, {
        status: TripRequestStatus.DRIVER_SELECTED,
        selectedDriverId: d.user.id,
        tripId: trip.id,
      });
      expect(
        (await sequentialCandidates(source.manager, wanted)).map(
          (c) => c.driverId,
        ),
      ).toContain(d.user.id);
    },
  );

  it('uses a valid arrival estimate plus a transfer margin, and falls back conservatively when it is missing', async () => {
    const { source, driver, request } = get();
    const d = await driver(),
      wanted = await request(false),
      assigned = await request(false);
    await move(source, wanted, 2);
    const trip = await source.getRepository(Trip).save({
      ...tripData(d.user.id, assigned.id),
      estimatedArrivalDate: at(1.25),
    });
    await source.getRepository(TripRequest).update(assigned.id, {
      status: TripRequestStatus.DRIVER_SELECTED,
      selectedDriverId: d.user.id,
      tripId: trip.id,
    });
    expect(
      (await sequentialCandidates(source.manager, wanted)).map(
        (c) => c.driverId,
      ),
    ).toContain(d.user.id);
    await source
      .getRepository(Trip)
      .update(trip.id, { estimatedArrivalDate: at(1.75) });
    expect(await sequentialCandidates(source.manager, wanted)).toHaveLength(0);
    await source
      .getRepository(Trip)
      .update(trip.id, { estimatedArrivalDate: null });
    expect(await sequentialCandidates(source.manager, wanted)).toHaveLength(0);
  });

  it.each([false, true])(
    'serializes two competing acceptances on the driver (compatible=%s)',
    async (compatible) => {
      const { source, driver, request } = get();
      const d = await driver(),
        first = await request(false),
        second = await request(false);
      if (compatible) await move(source, second, 6);
      const accept = (r: TripRequest) =>
        source.transaction(async (tx) => {
          await tx.getRepository(TripRequest).findOne({
            where: { id: r.id },
            lock: { mode: 'pessimistic_write' },
          });
          await assertDriverRequestSchedule(tx, d.user.id, r.id);
          await tx.getRepository(TripRequest).update(r.id, {
            status: TripRequestStatus.DRIVER_SELECTED,
            selectedDriverId: d.user.id,
          });
        });
      const results = await Promise.allSettled([accept(first), accept(second)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
        compatible ? 2 : 1,
      );
      if (!compatible)
        expect(results.find((r) => r.status === 'rejected')).toMatchObject({
          reason: { response: { code: 'DRIVER_SCHEDULE_CONFLICT' } },
        });
    },
  );

  it('protects a private request reservation from a conflicting public publication', async () => {
    const { source, driver, request } = get();
    const d = await driver(),
      assigned = await request(false);
    await source.getRepository(TripRequest).update(assigned.id, {
      status: TripRequestStatus.DRIVER_SELECTED,
      selectedDriverId: d.user.id,
    });
    await expect(
      source.transaction((tx) =>
        assertPublicationRequestSchedule(tx, {
          driverId: d.user.id,
          departureDate: at(1),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'DRIVER_SCHEDULE_CONFLICT' } });
    await source.transaction((tx) =>
      assertPublicationRequestSchedule(tx, {
        driverId: d.user.id,
        departureDate: at(6),
      }),
    );
  });

  it.each([false, true])(
    'serializes request acceptance against actual public publication (compatible=%s)',
    async (compatible) => {
      const { source, driver, request } = get();
      const d = await driver(),
        wanted = await request(false);
      const trips = source.getRepository(Trip);
      const publication = trips.create({
        ...tripData(d.user.id, wanted.id),
        tripRequestId: null,
        isPrivate: false,
        departureDate: at(compatible ? 6 : 1),
      });
      const results = await Promise.allSettled([
        source.transaction(async (tx) => {
          await tx.getRepository(TripRequest).findOne({
            where: { id: wanted.id },
            lock: { mode: 'pessimistic_write' },
          });
          await assertDriverRequestSchedule(tx, d.user.id, wanted.id);
          await tx.getRepository(TripRequest).update(wanted.id, {
            status: TripRequestStatus.DRIVER_SELECTED,
            selectedDriverId: d.user.id,
          });
        }),
        savePublicationsWithPhotoPolicy(trips, d.user.id, [publication]),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(compatible ? 2 : 1);
      if (!compatible)
        expect(
          results.find((result) => result.status === 'rejected'),
        ).toMatchObject({
          reason: { response: { code: 'DRIVER_SCHEDULE_CONFLICT' } },
        });
    },
  );

  it('does not rank old ongoing navigation as a fresh location ahead of a recently located driver', async () => {
    const { source, driver, request } = get();
    const old = await driver(15.3101),
      fresh = await driver(15.32),
      wanted = await request(false);
    await source.query(
      `UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '2 days' WHERE "driverId"=$1`,
      [old.user.id],
    );
    await source.getRepository(Trip).save({
      ...tripData(old.user.id, wanted.id, TripStatus.ACTIVE),
      tripRequestId: null,
      vehicleId: old.vehicle.id,
      currentLocation: { type: 'Point', coordinates: [15.3101, -4.3] },
      lastLocationUpdateAt: at(-48),
    });
    expect(
      (await sequentialCandidates(source.manager, wanted)).map(
        (c) => c.driverId,
      ),
    ).toEqual([fresh.user.id, old.user.id]);
  });
}
