import { DataSource } from 'typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TrackingStateService } from './tracking-state.service';
import { TrackingStateChangedException } from '../common/tracking-state-changed.exception';
import { BookingsService } from '../bookings/bookings.service';
import { readRideProgressBookings } from '../bookings/read-ride-progress';
import { In } from 'typeorm';
import { persistDriverLocation, persistPassengerLocation } from './persist-tracking-location';
import { readDriverTrackingTrip, readPassengerTrackingBooking } from './read-tracking-location';
import { DRIVER_TRACKING_SELECT, PASSENGER_TRACKING_COLUMNS } from './tracking-read-columns';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { PerformanceWorkQueues1780000135000 } from '../database/migrations/1780000135000-PerformanceWorkQueues';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripsService } from '../trips/trips.service';
import { completeTripTransaction } from '../trips/complete-trip-transaction';
import { User } from '../users/entities/user.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationService } from '../notifications/notifications.service';
import { enqueueTripStartNotifications } from '../trips/trip-start-notifications';
import { isTripStartDeliverable } from '../notifications/trip-start-delivery';
import { isRideProgressDeliverable } from '../notifications/ride-progress-delivery';
import { runExclusiveMaintenanceJob } from '../common/exclusive-maintenance-job';
import {
  claimRideProgress,
  finishAndClaimRideProgress,
  enqueueRideProgress,
  finishRideProgress,
} from './ride-progress-queue';

const bin = process.env.PERFORMANCE_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'performance fixes on isolated PostgreSQL (no application credentials)',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    beforeAll(async () => {
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
      await db.synchronize();
      const runner = db.createQueryRunner();
      try {
        await new PerformanceWorkQueues1780000135000().up(runner);
      } finally {
        await runner.release();
      }
    });
    afterAll(() => cluster.stop());
    beforeEach(() =>
      db.query('TRUNCATE users, maintenance_job_leases CASCADE'),
    );

    async function fixture() {
      const users = await db.getRepository(User).save(
        Array.from({ length: 7 }, (_, i) => ({
          firstName: `Synthetic${i}`,
          lastName: 'Test',
          isActive: i !== 5,
        })),
      );
      const [driver, accepted, pending, cancelled, stranger, disabled] = users;
      const trip = await db
        .getRepository(Trip)
        .save({
          driverId: driver.id,
          departureLocation: 'A',
          arrivalLocation: 'B',
          departureDate: new Date(),
          totalSeats: 6,
          availableSeats: 3,
          pricePerSeat: 2500,
          status: TripStatus.PENDING,
        });
      await db.getRepository(Booking).save(
        [
          [accepted.id, BookingStatus.ACCEPTED],
          [accepted.id, BookingStatus.ACCEPTED],
          [pending.id, BookingStatus.PENDING],
          [cancelled.id, BookingStatus.CANCELLED],
          [disabled.id, BookingStatus.ACCEPTED],
          [driver.id, BookingStatus.ACCEPTED],
        ].map(([passengerId, status]) => ({
          passengerId,
          status: status as BookingStatus,
          tripId: trip.id,
          numberOfSeats: 1,
        })),
      );
      const service: TripsService = Object.assign(
        Object.create(TripsService.prototype),
        {
          tripRepository: db.getRepository(Trip),
          logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() },
          cacheService: { del: jest.fn() },
          ensureDriverCanStartTrip: jest.fn(),
          calculateEstimatedArrivalDate: jest
            .fn()
            .mockResolvedValue(new Date()),
          notifyDriverEmergencyContacts: jest.fn(),
          findOne: (id: string) =>
            db.getRepository(Trip).findOneByOrFail({ id }),
        },
      );
      return {
        service,
        trip,
        driver,
        accepted,
        pending,
        cancelled,
        stranger,
        disabled,
      };
    }

    async function waitForSqlLock(pid: number) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [state] = await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
        if (state?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Expected concurrent SQL operation to wait for its row lock');
    }

    it('attributes real blocking queries and leased transactions without exporting SQL or identifiers', async () => {
      const f = await fixture();
      const api = new DataSource({ ...db.options, entities: typeOrmEntities,
        extra: { max: 3, application_name: 'zwanga-journey-api', statement_timeout: 5000 } });
      await api.initialize();
      const { SqlProfiler } = require('../../test/load/journeys/sql-profiler.cjs');
      const { postgresActivity } = require('../../test/load/journeys/postgres-activity.cjs');
      const profile = new SqlProfiler(['users']); profile.install(api);
      const holder = api.createQueryRunner(), waiter = api.createQueryRunner();
      let waiting: Promise<unknown> | undefined;
      try {
        await profile.activity('test:holder', async () => {
          await holder.startTransaction();
          await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.driver.id]);
          // A savepoint is not a second outer transaction, nor does rolling it
          // back release the outer transaction's locks or connection.
          await holder.startTransaction(); await holder.rollbackTransaction();
        });
        const [{ pid }] = await waiter.query('SELECT pg_backend_pid() AS pid');
        waiting = Promise.resolve(profile.activity('test:waiter', () => waiter.query(
          'UPDATE users SET "firstName"=$2 WHERE id=$1', [f.driver.id, 'private-fixture-value'])));
        const settled = waiting.then(() => 'ok', () => 'failed');
        await waitForSqlLock(pid);
        const sample = await postgresActivity(db, { detailed: true });
        expect(sample.blocking).toEqual(expect.arrayContaining([expect.objectContaining({
          waitingQuery: expect.objectContaining({ operation: 'UPDATE', tables: ['users'] }),
          blockerState: 'idle in transaction', links: 1,
        })]));
        const active = profile.snapshot().connectionOccupancy.active;
        expect(active).toEqual(expect.arrayContaining([expect.objectContaining({ transactionContext: 'test:holder' })]));
        expect(JSON.stringify(sample)).not.toContain(f.driver.id);
        expect(JSON.stringify(sample)).not.toContain('private-fixture-value');
        await holder.commitTransaction(); expect(await settled).toBe('ok');
        await holder.release(); await waiter.release();
        const occupancy = profile.snapshot().connectionOccupancy;
        expect(occupancy.active).toEqual([]);
        expect(occupancy.groups.filter((g: any) => g.kind === 'transaction')).toEqual([
          expect.objectContaining({ context: 'test:holder', count: 1, outcomes: { commit: 1 } }),
        ]);
        expect(occupancy.groups.find((g: any) => g.kind === 'lease' && g.context === 'test:holder').totalMs).toBeGreaterThan(0);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await waiting?.catch(() => {});
        await holder.release(); await waiter.release(); await api.destroy();
      }
    });

    it('reads the exact former GPS projection without ORM hydration and sees later ownership/status changes', async () => {
      const f = await fixture();
      const trips = db.getRepository(Trip), bookings = db.getRepository(Booking);
      const b = await bookings.findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      const compare = async () => {
        const trip = await readDriverTrackingTrip(trips, f.trip.id);
        expect(trip).toEqual(await trips.findOne({ where: { id: f.trip.id }, select: DRIVER_TRACKING_SELECT }));
        const booking = await readPassengerTrackingBooking(bookings, b.id, f.accepted.id);
        expect(booking).toEqual(await bookings.createQueryBuilder('booking')
          .leftJoinAndSelect('booking.trip', 'trip').select(PASSENGER_TRACKING_COLUMNS)
          .where('booking.id = :id AND booking.passengerId = :passengerId', { id: b.id, passengerId: f.accepted.id }).getOne());
        return { trip, booking };
      };
      await compare(); // null geometry/timestamps retain their original semantics
      const now = new Date('2026-11-23T10:00:00.123Z');
      const point = { type: 'Point' as const, coordinates: [15.123456789, -4.123456789] };
      await trips.update(f.trip.id, { status: TripStatus.ACTIVE, currentLocation: point,
        departurePoint: point, arrivalPoint: point, lastLocationUpdateAt: now });
      await bookings.update(b.id, { passengerCurrentLocation: point, passengerDestinationPoint: point,
        passengerLastLocationUpdateAt: now, pickedUp: true, pickedUpAt: now,
        pickedUpConfirmedByPassenger: true, pickedUpConfirmedAt: now, droppedOff: true,
        droppedOffAt: now, droppedOffConfirmedByPassenger: true, droppedOffConfirmedAt: now,
        destinationProximityNotified: true });
      const populated = await compare();
      expect(populated.trip!.lastLocationUpdateAt).toBeInstanceOf(Date);
      expect(populated.booking!.passengerLastLocationUpdateAt).toBeInstanceOf(Date);
      expect(populated.booking!.pickedUpAt).toEqual(now);
      expect(await readPassengerTrackingBooking(bookings, b.id, f.stranger.id)).toBeNull();
      await trips.update(f.trip.id, { driverId: f.stranger.id, status: TripStatus.COMPLETED });
      await bookings.update(b.id, { passengerId: f.stranger.id, status: BookingStatus.CANCELLED });
      expect(await readDriverTrackingTrip(trips, f.trip.id)).toMatchObject({ driverId: f.stranger.id, status: TripStatus.COMPLETED });
      expect(await readPassengerTrackingBooking(bookings, b.id, f.accepted.id)).toBeNull();
      expect(await readPassengerTrackingBooking(bookings, b.id, f.stranger.id)).toMatchObject({ status: BookingStatus.CANCELLED,
        trip: { status: TripStatus.COMPLETED } });
      expect(await readDriverTrackingTrip(trips, f.stranger.id)).toBeNull();
    });

    it('reads fresh ride progress with identical booking/trip values and only passenger names', async () => {
      const f = await fixture();
      const repository = db.getRepository(Booking);
      // This dedicated reader does not implement ORM lifecycle hooks. Make a
      // future entity change requiring one fail here rather than silently skip it.
      for (const entity of [Booking, Trip, User]) {
        expect(db.getMetadata(entity).afterLoadListeners).toHaveLength(0);
        expect(db.getMetadata(entity).eagerRelations).toHaveLength(0);
        expect(db.getMetadata(entity).deleteDateColumn).toBeUndefined();
      }
      const statuses = [BookingStatus.ACCEPTED, BookingStatus.NO_SHOW, BookingStatus.BOARDING_UNCERTAIN];
      const reference = async () => (await repository.find({ where: { tripId: f.trip.id, status: In(statuses) },
        relations: ['trip', 'passenger'] })).map(b => ({ ...b, passenger: b.passenger && {
          id: b.passenger.id, firstName: b.passenger.firstName, lastName: b.passenger.lastName,
        } }));
      const ordered = (rows: Booking[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
      const compare = async () => {
        const expected = await reference();
        const query = jest.spyOn(repository, 'query');
        try {
          const rows = await readRideProgressBookings(repository, f.trip.id);
          expect(ordered(rows)).toEqual(ordered(expected as Booking[]));
          expect(query).toHaveBeenCalledTimes(1);
          const [sql, parameters] = query.mock.calls[0];
          expect(parameters).toEqual([[f.trip.id], ...statuses]);
          expect(sql).not.toContain('rideDeclarations');
          expect(sql).not.toContain('fcmToken');
          expect(sql).not.toContain('password');
          return rows;
        } finally { query.mockRestore(); }
      };
      await compare(); // null positions/dates, default numeric strings and JSON arrays
      const now = new Date('2026-11-23T11:00:00.123Z');
      const point = { type: 'Point' as const, coordinates: [15.123456789, -4.123456789] };
      await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.ACTIVE, startedAt: now,
        currentLocation: point, departurePoint: point, arrivalPoint: point,
        lastLocationUpdateAt: now, driverSafetyEmergencyContactIds: [f.driver.id] });
      await repository.update({ tripId: f.trip.id }, { passengerCurrentLocation: point, passengerOriginPoint: point,
        passengerDestinationPoint: point, passengerLastLocationUpdateAt: now, paymentAmount: 12345678.9,
        firstTripSubsidyApplied: true, passengerPaymentRate: 0.123456, pickedUpAt: now,
        mixedPaymentAt: now, safetyEmergencyContactIds: [f.accepted.id] });
      await db.query(`UPDATE bookings SET "rideDeclarations"='{"pickup":{"passenger":{"receivedAt":"2026-11-23"}}}'
        WHERE "tripId"=$1`, [f.trip.id]);
      const populated = await compare();
      expect(populated[0].trip.lastLocationUpdateAt).toEqual(now);
      expect(populated[0].pickedUpAt).toBeInstanceOf(Date);
      expect(populated[0].mixedPaymentAt).toEqual(now);
      expect(populated[0].rideDeclarations).toBeUndefined();
      expect(populated[0].trip).toBeInstanceOf(Trip);
      await repository.update(populated[0].id, { status: BookingStatus.CANCELLED });
      await repository.update(populated[1].id, { status: BookingStatus.NO_SHOW });
      await repository.update(populated[2].id, { status: BookingStatus.BOARDING_UNCERTAIN });
      await db.getRepository(User).update(f.accepted.id, { firstName: 'Changed', fcmToken: 'do-not-project' });
      await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.COMPLETED, driverId: f.stranger.id });
      const changed = await compare();
      expect(changed).toHaveLength(populated.length - 1);
      expect(changed.every(b => b.trip.status === TripStatus.COMPLETED && b.trip.driverId === f.stranger.id)).toBe(true);
      expect(await readRideProgressBookings(repository, f.stranger.id)).toEqual([]);
    });

    it('batches fresh GPS/progress across trips without mixing owners, rows or mutable entity values', async () => {
      const a = await fixture(), b = await fixture();
      const trips = db.getRepository(Trip), bookings = db.getRepository(Booking);
      const ba = await bookings.findOneByOrFail({ tripId: a.trip.id, passengerId: a.accepted.id });
      const bb = await bookings.findOneByOrFail({ tripId: b.trip.id, passengerId: b.accepted.id });
      const tripQuery = jest.spyOn(trips, 'query'), bookingQuery = jest.spyOn(bookings, 'query');
      try {
        const driverRows = await Promise.all([a.trip.id, b.trip.id, a.stranger.id, a.trip.id.toUpperCase()]
          .map(id => readDriverTrackingTrip(trips, id)));
        expect(tripQuery).toHaveBeenCalledTimes(1);
        expect(driverRows.map(row => row?.id ?? null)).toEqual([a.trip.id, b.trip.id, null, a.trip.id]);
        driverRows[0]!.status = TripStatus.COMPLETED;
        expect(driverRows[3]!.status).toBe(TripStatus.PENDING);
        const passengerRows = await Promise.all([
          readPassengerTrackingBooking(bookings, ba.id, a.accepted.id),
          readPassengerTrackingBooking(bookings, bb.id.toUpperCase(), b.accepted.id.toUpperCase()),
          readPassengerTrackingBooking(bookings, ba.id, b.accepted.id),
          readPassengerTrackingBooking(bookings, bb.id, a.accepted.id),
        ]);
        expect(bookingQuery).toHaveBeenCalledTimes(1);
        expect(passengerRows.map(row => row?.id ?? null)).toEqual([ba.id, bb.id, null, null]);
        bookingQuery.mockClear();
        const progress = await Promise.all([a.trip.id, b.trip.id, a.stranger.id, a.trip.id.toUpperCase()]
          .map(id => readRideProgressBookings(bookings, id)));
        expect(bookingQuery).toHaveBeenCalledTimes(1);
        expect(progress.map(rows => rows.length)).toEqual([4, 4, 0, 4]);
        expect(progress[0].every(row => row.tripId === a.trip.id && row.trip.id === a.trip.id)).toBe(true);
        expect(progress[1].every(row => row.tripId === b.trip.id && row.trip.id === b.trip.id)).toBe(true);
        progress[0][0].trip.driverSafetyEmergencyContactIds.push('caller-local-mutation');
        expect(progress[3][0].trip.driverSafetyEmergencyContactIds).not.toContain('caller-local-mutation');
        expect(progress[3][0]).toBeInstanceOf(Booking);
        expect(progress[3][0].trip).toBeInstanceOf(Trip);
      } finally { tripQuery.mockRestore(); bookingQuery.mockRestore(); }
      await bookings.update(ba.id, { passengerId: b.accepted.id, status: BookingStatus.CANCELLED });
      const [oldOwner, newOwner, currentProgress] = await Promise.all([
        readPassengerTrackingBooking(bookings, ba.id, a.accepted.id),
        readPassengerTrackingBooking(bookings, ba.id, b.accepted.id),
        readRideProgressBookings(bookings, a.trip.id),
      ]);
      expect(oldOwner).toBeNull();
      expect(newOwner?.status).toBe(BookingStatus.CANCELLED);
      expect(currentProgress).toHaveLength(3);
    });

    it('profiles the progress projection against the former ORM read without imposing machine-specific timings', async () => {
      const f = await fixture();
      const repository = db.getRepository(Booking);
      const oldRead = () => repository.find({ where: { tripId: f.trip.id,
        status: In([BookingStatus.ACCEPTED, BookingStatus.NO_SHOW, BookingStatus.BOARDING_UNCERTAIN]) }, relations: ['trip', 'passenger'] });
      const newRead = () => readRideProgressBookings(repository, f.trip.id);
      await oldRead(); await newRead();
      const samples: number[][] = [[], []];
      for (let index = 0; index < 80; index++) {
        for (const which of index % 2 ? [1, 0] : [0, 1]) {
          const started = performance.now();
          expect(await (which ? newRead() : oldRead())).toHaveLength(4);
          samples[which].push(performance.now() - started);
        }
      }
      console.log('[ride-progress-read] ' + JSON.stringify(samples.map((values, index) => ({
        mode: index ? 'compiled-projection' : 'orm', samples: values.length,
        meanMs: values.reduce((a, b) => a + b, 0) / values.length,
        p95Ms: values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1],
      }))));
    });

    it('recovers committed completion only for the scoped driver or booking owner', async () => {
      const f = await fixture();
      const booking = await db.getRepository(Booking).findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.COMPLETED });
      await db.getRepository(Booking).update(booking.id, { status: BookingStatus.COMPLETED, pickedUp: true, droppedOff: true });
      const recovery = new TrackingStateService(db);
      await expect(recovery.read(f.driver.id, f.trip.id)).resolves.toMatchObject({ tripStatus: 'completed', bookingId: null });
      await expect(recovery.read(f.accepted.id, f.trip.id, booking.id)).resolves.toMatchObject({ bookingStatus: 'completed', droppedOff: true });
      for (const user of [f.stranger, f.pending, f.driver]) {
        await expect(recovery.read(user.id, f.trip.id, booking.id)).rejects.toBeInstanceOf(NotFoundException);
      }
      await expect(recovery.read(f.accepted.id, f.trip.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.service.updateDriverLocation(f.stranger.id, f.trip.id, [15.31, -4.3])).rejects.toBeInstanceOf(ForbiddenException);
      await expect(f.service.updateDriverLocation(f.driver.id, f.trip.id, [15.31, -4.3])).rejects.toBeInstanceOf(TrackingStateChangedException);
      const bookings: BookingsService = Object.assign(Object.create(BookingsService.prototype), { bookingRepository: db.getRepository(Booking) });
      await expect(bookings.updatePassengerLocation(f.stranger.id, booking.id, { latitude: -4.3, longitude: 15.31 })).rejects.toBeInstanceOf(NotFoundException);
      await expect(bookings.updatePassengerLocation(f.accepted.id, booking.id, { latitude: -4.3, longitude: 15.31 })).rejects.toBeInstanceOf(TrackingStateChangedException);
    });

    it('loads passenger GPS state in one SELECT, retaining the trip and SQL ownership scope', async () => {
      const f = await fixture();
      const repository = db.getRepository(Booking);
      const booking = await repository.findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.ACTIVE });
      const expected = await repository.findOneOrFail({ where: { id: booking.id }, relations: ['trip'] });
      const service: BookingsService = Object.assign(Object.create(BookingsService.prototype), {
        bookingRepository: repository,
        locationHistoryService: { recordPassengerLocation: jest.fn() },
        touchTripInteraction: jest.fn(),
        progressAfterPassengerLocation: jest.fn().mockResolvedValue({ tripId: f.trip.id, events: [] }),
      });
      const read = (id: string, owner: string) => (service as any).findPassengerTrackingBooking(id, owner);
      const queries = jest.spyOn(db.logger, 'logQuery').mockImplementation(() => {});
      try {
        const selected = await read(booking.id, f.accepted.id);
        expect(selected).toMatchObject({
          id: expected.id, tripId: expected.tripId, passengerId: expected.passengerId,
          status: expected.status, passengerCurrentLocation: expected.passengerCurrentLocation,
          passengerLastLocationUpdateAt: expected.passengerLastLocationUpdateAt,
          passengerDestinationPoint: expected.passengerDestinationPoint,
          destinationProximityNotified: expected.destinationProximityNotified,
          pickedUp: expected.pickedUp, pickedUpAt: expected.pickedUpAt,
          pickedUpConfirmedByPassenger: expected.pickedUpConfirmedByPassenger,
          pickedUpConfirmedAt: expected.pickedUpConfirmedAt,
          droppedOff: expected.droppedOff, droppedOffAt: expected.droppedOffAt,
          droppedOffConfirmedByPassenger: expected.droppedOffConfirmedByPassenger,
          droppedOffConfirmedAt: expected.droppedOffConfirmedAt,
          trip: { id: f.trip.id, status: TripStatus.ACTIVE,
            departurePoint: expected.trip.departurePoint, arrivalPoint: expected.trip.arrivalPoint },
        });
        expect(selected.numberOfSeats).toBeUndefined();
        expect(selected.trip.pricePerSeat).toBeUndefined();
        expect(queries).toHaveBeenCalledTimes(1);
        expect(queries.mock.calls[0][0]).toMatch(/^SELECT .*LEFT JOIN "?trips"?/s);
        expect(queries.mock.calls[0][0]).not.toContain('DISTINCT');
        expect(queries.mock.calls[0][1]).toEqual([[booking.id], [f.accepted.id]]);
        queries.mockClear();
        await expect(service.updatePassengerLocation(f.stranger.id, booking.id, {
          latitude: -4.3, longitude: 15.31,
        }, { deferProgress: true })).rejects.toBeInstanceOf(NotFoundException);
        expect(queries).toHaveBeenCalledTimes(1); // no write for another passenger
        queries.mockClear();
        await expect(service.updatePassengerLocation(f.accepted.id, booking.id, {
          latitude: -4.3, longitude: 15.31,
        }, { deferProgress: true })).resolves.toMatchObject({ bookingId: booking.id, tripId: f.trip.id });
        expect(queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT'))).toHaveLength(1);
        expect(queries.mock.calls.filter(([sql]) => sql.startsWith('WITH changed'))).toHaveLength(1);
        expect(queries.mock.calls.filter(([sql]) => sql.startsWith('INSERT') || sql.startsWith('UPDATE'))).toHaveLength(0);
        expect((service as any).touchTripInteraction).not.toHaveBeenCalled();
      } finally {
        queries.mockRestore();
      }
    });

    it('keeps driver GPS authorization and geometry while omitting unrelated trip columns', async () => {
      const f = await fixture();
      const point = { type: 'Point' as const, coordinates: [15.31, -4.3] };
      await db.getRepository(Trip).update(f.trip.id, {
        status: TripStatus.ACTIVE, departurePoint: point, arrivalPoint: point,
      });
      const recordDriverLocation = jest.fn();
      Object.assign(f.service, { locationHistoryService: { recordDriverLocation } });
      const queries = jest.spyOn(db.logger, 'logQuery').mockImplementation(() => {});
      try {
        await expect(f.service.updateDriverLocation(f.driver.id, f.trip.id, [15.31, -4.3]))
          .resolves.toMatchObject({ tripId: f.trip.id, coordinates: [15.31, -4.3] });
        const reads = queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT'));
        expect(reads).toHaveLength(1);
        for (const column of ['driverId', 'status', 'currentLocation', 'lastLocationUpdateAt', 'departurePoint', 'arrivalPoint']) {
          expect(reads[0][0]).toContain(`"${column}"`);
        }
        for (const column of ['description', 'pricePerSeat', 'totalSeats']) {
          expect(reads[0][0]).not.toContain(`"${column}"`);
        }
        expect(recordDriverLocation).toHaveBeenCalledTimes(1);
        // Removing large columns must not remove the authoritative route bounds.
        await expect(f.service.updateDriverLocation(f.driver.id, f.trip.id, [25.2, -3.0]))
          .rejects.toThrow('Position conducteur');
        expect(recordDriverLocation).toHaveBeenCalledTimes(1);
      } finally { queries.mockRestore(); }
    });

    it('persists automatic ride alerts in one statement and deduplicates concurrent replays', async () => {
      const f = await fixture();
      const booking = await db.getRepository(Booking).findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      const repository = db.getRepository(Notification);
      const service: NotificationService = Object.assign(Object.create(NotificationService.prototype), {
        notificationRepository: repository,
      });
      const data = { type: 'pickup_confirmed_automatically', tripId: f.trip.id, bookingId: booking.id };
      const send = () => service.sendNotification('', 'Pickup', 'Passenger boarded', data, f.accepted.id);
      const queries = jest.spyOn(db.logger, 'logQuery').mockImplementation(() => {});
      try {
        await expect(send()).resolves.toBe(true);
        expect(queries).toHaveBeenCalledTimes(1);
        expect(queries.mock.calls[0][0]).toMatch(/^INSERT INTO "notifications"/);
        expect(queries.mock.calls[0][0]).toContain('ON CONFLICT ("eventKey") DO NOTHING');
      } finally { queries.mockRestore(); }
      await Promise.all(Array.from({ length: 8 }, send));
      const rows = await repository.find();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: f.accepted.id, status: 'pending', fcmToken: '', data,
        eventKey: `ride-progress:${booking.id}:${data.type}:${f.accepted.id}`,
      });
      // Persistence is not permission to deliver: the fresh-state guard remains.
      expect(await isRideProgressDeliverable(db.manager, rows[0])).toBe(false);
      await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.ACTIVE });
      await db.getRepository(Booking).update(booking.id, { pickedUp: true, pickedUpAt: new Date() });
      expect(await isRideProgressDeliverable(db.manager, rows[0])).toBe(true);
      await db.getRepository(Booking).update(booking.id, { status: BookingStatus.CANCELLED });
      expect(await isRideProgressDeliverable(db.manager, rows[0])).toBe(false);
    });

    it('never acknowledges an unpersisted ride alert and still honors an enclosing business rollback', async () => {
      const f = await fixture();
      const booking = await db.getRepository(Booking).findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      const send = (repository = db.getRepository(Notification)) => {
        const service: NotificationService = Object.assign(Object.create(NotificationService.prototype), {
          notificationRepository: repository,
        });
        return service.sendNotification('', 'Pickup', 'Passenger boarded', {
          type: 'pickup_confirmed_automatically', tripId: f.trip.id, bookingId: booking.id,
        }, f.accepted.id);
      };
      await db.query('ALTER TABLE notifications ADD CONSTRAINT test_reject_alert CHECK (false) NOT VALID');
      try {
        await expect(send()).rejects.toMatchObject({ code: '23514' });
        expect(await db.getRepository(Notification).count()).toBe(0);
      } finally {
        await db.query('ALTER TABLE notifications DROP CONSTRAINT test_reject_alert');
      }
      await expect(db.transaction(async manager => {
        await expect(send(manager.getRepository(Notification))).resolves.toBe(true);
        expect(await manager.getRepository(Notification).count()).toBe(1);
        // An independent worker cannot see the event before the business commit.
        expect(await db.getRepository(Notification).count()).toBe(0);
        throw new Error('business rollback');
      })).rejects.toThrow('business rollback');
      expect(await db.getRepository(Notification).count()).toBe(0);
    });

    for (const passenger of [false, true]) {
      it(`refuses ${passenger ? 'passenger' : 'driver'} GPS when a concurrent completion wins the conditional SQL write`, async () => {
        const f = await fixture();
        const tripRepo = db.getRepository(Trip);
        const bookingRepo = db.getRepository(Booking);
        const booking = await bookingRepo.findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
        const older = new Date(Date.now() - 1000);
        const point = { type: 'Point' as const, coordinates: [15.31, -4.3] };
        await tripRepo.update(f.trip.id, { status: TripStatus.ACTIVE, currentLocation: point, lastLocationUpdateAt: older });
        await bookingRepo.update(booking.id, { passengerCurrentLocation: point, passengerLastLocationUpdateAt: older });
        const history = { recordDriverLocation: jest.fn(), recordPassengerLocation: jest.fn() };
        const progress = jest.fn();
        const bookings: BookingsService = Object.assign(Object.create(BookingsService.prototype), {
          bookingRepository: bookingRepo, locationHistoryService: history, progressAfterPassengerLocation: progress,
        });
        Object.assign(f.service, { locationHistoryService: history });
        const repository = passenger ? bookingRepo : tripRepo;
        const write = repository.query.bind(repository);
        let affected: number | null | undefined;
        // Pause at the actual conditional write. Another transaction commits
        // completion after the service's initial read; no SQL result is mocked.
        const intercept = jest.spyOn(repository as any, 'query').mockImplementation(async (...args: any[]) => {
          if (!String(args[0]).startsWith('WITH changed AS') || affected !== undefined) return write(args[0], args[1]);
          await db.transaction(async manager => {
            await manager.update(Booking, booking.id, { status: BookingStatus.COMPLETED, pickedUp: true, droppedOff: true });
            await manager.update(Trip, f.trip.id, { status: TripStatus.COMPLETED });
          });
          const result = await write(args[0], args[1]);
          affected = result.length;
          return result;
        });
        try {
          const result = passenger
            ? bookings.updatePassengerLocation(f.accepted.id, booking.id, { latitude: -4.3, longitude: 15.32 }, { deferProgress: true })
            : f.service.updateDriverLocation(f.driver.id, f.trip.id, [15.32, -4.3]);
          await expect(result).rejects.toBeInstanceOf(TrackingStateChangedException);
          expect(affected).toBe(0);
          expect(history.recordDriverLocation).not.toHaveBeenCalled();
          expect(history.recordPassengerLocation).not.toHaveBeenCalled();
          expect(progress).not.toHaveBeenCalled();
          const savedTrip = await tripRepo.findOneByOrFail({ id: f.trip.id });
          const savedBooking = await bookingRepo.findOneByOrFail({ id: booking.id });
          expect(savedTrip.currentLocation).toEqual(point);
          expect(savedTrip.lastLocationUpdateAt).toEqual(older);
          expect(savedBooking.passengerCurrentLocation).toEqual(point);
          expect(savedBooking.passengerLastLocationUpdateAt).toEqual(older);
          await expect(new TrackingStateService(db).read(
            passenger ? f.accepted.id : f.driver.id, f.trip.id, passenger ? booking.id : undefined,
          )).resolves.toMatchObject({ tripStatus: 'completed', ...(passenger ? { bookingStatus: 'completed', droppedOff: true } : {}) });
        } finally {
          intercept.mockRestore();
        }
      });
    }

    for (const passenger of [false, true]) {
      it(`${passenger ? 'passenger' : 'driver'} GPS and durable queue commit atomically with ownership, ordering and lease preservation`, async () => {
        const f = await fixture();
        const booking = await db.getRepository(Booking).findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
        await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.ACTIVE });
        const beforeActivity = new Date('2020-01-01T00:00:00Z');
        await db.query('UPDATE trips SET "updatedAt"=$2 WHERE id=$1', [f.trip.id, beforeActivity]);
        const tripActivity = async () => (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id })).updatedAt;
        const at = new Date();
        const input = { tripId: f.trip.id, bookingId: booking.id, ownerId: passenger ? f.accepted.id : f.driver.id,
          longitude: 15.31, latitude: -4.3, observedAt: at };
        const persist = passenger ? persistPassengerLocation : persistDriverLocation;
        expect(await persist(db, { ...input, ownerId: f.stranger.id })).toBe(false);
        expect(await tripActivity()).toEqual(beforeActivity);
        expect(await db.query('SELECT * FROM ride_progress_jobs')).toHaveLength(0);
        const calls = jest.spyOn(db, 'query');
        try {
          expect(await persist(db, input)).toBe(true);
          expect(calls).toHaveBeenCalledTimes(1);
        } finally { calls.mockRestore(); }
        const acceptedActivity = await tripActivity();
        expect(acceptedActivity.getTime()).toBeGreaterThan(beforeActivity.getTime());
        const [job] = await claimRideProgress(db, 4);
        expect(job.version).toBe('1');
        expect(await persist(db, { ...input, longitude: 15.2, observedAt: new Date(at.getTime() - 1) })).toBe(false);
        expect(await tripActivity()).toEqual(acceptedActivity);
        expect(await persist(db, { ...input, longitude: 15.32, observedAt: new Date(at.getTime() + 1) })).toBe(true);
        const [queued] = await db.query('SELECT * FROM ride_progress_jobs');
        expect(queued.version).toBe('2');
        expect(queued.leaseToken).toBe(job.leaseToken);
        const stored = passenger
          ? await db.getRepository(Booking).findOneByOrFail({ id: booking.id })
          : await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id });
        expect(passenger ? (stored as Booking).passengerCurrentLocation?.coordinates : (stored as Trip).currentLocation?.coordinates)
          .toEqual([15.32, -4.3]);
        expect(passenger ? (stored as Booking).passengerLastLocationUpdateAt : (stored as Trip).lastLocationUpdateAt)
          .toEqual(new Date(at.getTime() + 1));
        await db.getRepository(passenger ? Booking : Trip as any).update(passenger ? booking.id : f.trip.id, { status: 'completed' });
        const completedActivity = await tripActivity();
        expect(await persist(db, { ...input, observedAt: new Date(at.getTime() + 2) })).toBe(false);
        expect(await tripActivity()).toEqual(completedActivity);
        expect((await db.query('SELECT version FROM ride_progress_jobs'))[0].version).toBe('2');
      });

      it(`rolls back ${passenger ? 'passenger' : 'driver'} GPS if the queue cannot be persisted`, async () => {
        const f = await fixture();
        const booking = await db.getRepository(Booking).findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
        const point = { type: 'Point' as const, coordinates: [15.3, -4.3] };
        const older = new Date(Date.now() - 1000);
        await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.ACTIVE, currentLocation: point, lastLocationUpdateAt: older });
        await db.getRepository(Booking).update(booking.id, { passengerCurrentLocation: point, passengerLastLocationUpdateAt: older });
        const activity = (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id })).updatedAt;
        // Fresh isolated cluster only: deliberately fail the final CTE.
        await db.query('ALTER TABLE ride_progress_jobs ADD CONSTRAINT test_reject_gps CHECK (false) NOT VALID');
        try {
          const persist = passenger ? persistPassengerLocation : persistDriverLocation;
          await expect(persist(db, { tripId: f.trip.id, bookingId: booking.id,
            ownerId: passenger ? f.accepted.id : f.driver.id, longitude: 15.32, latitude: -4.3, observedAt: new Date(),
          })).rejects.toMatchObject({ code: '23514' });
          const trip = await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id });
          const saved = await db.getRepository(Booking).findOneByOrFail({ id: booking.id });
          expect(trip.currentLocation).toEqual(point);
          expect(trip.lastLocationUpdateAt).toEqual(older);
          expect(trip.updatedAt).toEqual(activity);
          expect(saved.passengerCurrentLocation).toEqual(point);
          expect(saved.passengerLastLocationUpdateAt).toEqual(older);
          expect(await db.query('SELECT * FROM ride_progress_jobs')).toHaveLength(0);
        } finally {
          await db.query('ALTER TABLE ride_progress_jobs DROP CONSTRAINT test_reject_gps');
        }
      });
    }

    it('rolls passenger GPS back when updating trip activity fails', async () => {
      const f = await fixture();
      const booking = await db.getRepository(Booking).findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.ACTIVE });
      await db.query('ALTER TABLE trips ADD CONSTRAINT test_reject_activity CHECK (false) NOT VALID');
      try {
        await expect(persistPassengerLocation(db, { tripId: f.trip.id, bookingId: booking.id,
          ownerId: f.accepted.id, longitude: 15.31, latitude: -4.3, observedAt: new Date(),
        })).rejects.toMatchObject({ code: '23514' });
        const stored = await db.getRepository(Booking).findOneByOrFail({ id: booking.id });
        expect(stored.passengerLastLocationUpdateAt).toBeNull();
        expect(stored.passengerCurrentLocation).toBeNull();
        expect(await db.query('SELECT * FROM ride_progress_jobs')).toEqual([]);
      } finally { await db.query('ALTER TABLE trips DROP CONSTRAINT test_reject_activity'); }
    });

    it('concurrent passenger/driver GPS and completion preserve booking -> trip lock order', async () => {
      const f = await fixture();
      const booking = await db.getRepository(Booking).findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      await db.getRepository(Trip).update(f.trip.id, { status: TripStatus.ACTIVE });
      const blocker = db.createQueryRunner(), gps = db.createQueryRunner();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.connect(); await gps.connect();
        await gps.query("SET statement_timeout='8s'");
        const [{ pid }] = await gps.query('SELECT pg_backend_pid() AS pid');
        await blocker.startTransaction();
        await blocker.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE', [f.trip.id]);
        const sample = { tripId: f.trip.id, bookingId: booking.id, ownerId: f.accepted.id,
          longitude: 15.31, latitude: -4.3, observedAt: new Date() };
        const passenger = persistPassengerLocation(gps, sample);
        pending.push(passenger); void passenger.catch(() => {});
        await waitForSqlLock(pid); // passenger now owns booking and waits for trip
        const completed = completeTripTransaction(db.getRepository(Trip), f.trip.id, f.driver.id, new Date(), () => true);
        const driver = persistDriverLocation(db, { ...sample, ownerId: f.driver.id });
        pending.push(completed, driver); void completed.catch(() => {}); void driver.catch(() => {});
        await blocker.commitTransaction();
        await expect(passenger).resolves.toBe(true);
        await expect(completed).resolves.toBe(true);
        await driver; // may precede completion or be correctly refused after it
        const stored = await db.getRepository(Booking).findOneByOrFail({ id: booking.id });
        expect(stored.passengerCurrentLocation?.coordinates).toEqual([15.31, -4.3]);
        expect((await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id })).status).toBe(TripStatus.COMPLETED);
        expect(await db.query('SELECT * FROM ride_progress_jobs')).toHaveLength(1);
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        await Promise.allSettled(pending);
        await gps.query('RESET statement_timeout');
        await gps.release(); await blocker.release();
      }
    });

    it('concurrent real starts enqueue exactly one accepted passenger, not strangers, driver or inactive/cancelled/pending bookings', async () => {
      const f = await fixture();
      await Promise.all([
        f.service.startTrip(f.trip.id, f.driver.id),
        f.service.startTrip(f.trip.id, f.driver.id),
      ]);
      const rows = await db.getRepository(Notification).find();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: f.accepted.id,
        status: 'pending',
        data: { type: 'trip_started', tripId: f.trip.id },
      });
      expect(await isTripStartDeliverable(db.manager, rows[0])).toBe(true);
      for (const user of [
        f.pending,
        f.cancelled,
        f.stranger,
        f.disabled,
        f.driver,
      ]) {
        expect(
          await isTripStartDeliverable(db.manager, {
            ...rows[0],
            userId: user.id,
          }),
        ).toBe(false);
      }
      await db
        .getRepository(Booking)
        .update(
          { tripId: f.trip.id, passengerId: f.accepted.id },
          { status: BookingStatus.CANCELLED },
        );
      expect(await isTripStartDeliverable(db.manager, rows[0])).toBe(false);
    });

    it('failed business transaction leaves no start or outbox record; replay deduplicates', async () => {
      const f = await fixture();
      await expect(
        db.transaction(async (manager) => {
          await manager.update(Trip, f.trip.id, { status: TripStatus.ACTIVE });
          await enqueueTripStartNotifications(manager, f.trip, 'transition');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await db.getRepository(Notification).count()).toBe(0);
      expect(
        (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }))
          .status,
      ).toBe(TripStatus.PENDING);
      await db.transaction(async (manager) => {
        await enqueueTripStartNotifications(manager, f.trip, 'transition');
        await enqueueTripStartNotifications(manager, f.trip, 'transition');
      });
      const notification = await db
        .getRepository(Notification)
        .findOneByOrFail({ userId: f.accepted.id });
      expect(await db.getRepository(Notification).count()).toBe(1);
      expect(await isTripStartDeliverable(db.manager, notification)).toBe(
        false,
      ); // not started
      await db
        .getRepository(Trip)
        .update(f.trip.id, { status: TripStatus.COMPLETED });
      expect(await isTripStartDeliverable(db.manager, notification)).toBe(
        false,
      );
      expect(
        await isTripStartDeliverable(db.manager, {
          ...notification,
          data: { tripId: 'invalid' },
        }),
      ).toBe(false);
    });

    it('competing workers cannot claim the same job; a GPS sample during evaluation survives completion', async () => {
      const f = await fixture();
      await enqueueRideProgress(db, f.trip.id);
      const batches = await Promise.all([
        claimRideProgress(db, 4),
        claimRideProgress(db, 4),
      ]);
      const jobs = batches.flat();
      expect(jobs).toHaveLength(1);
      await enqueueRideProgress(db, f.trip.id);
      expect(await claimRideProgress(db, 4)).toEqual([]);
      const finishQueries = jest.spyOn(db, 'query');
      try {
        await finishRideProgress(db, jobs[0], false);
        expect(finishQueries).toHaveBeenCalledTimes(1); // retain newer GPS and release in the same statement
      } finally {
        finishQueries.mockRestore();
      }
      const [pending] = await db.query('SELECT * FROM ride_progress_jobs');
      expect(pending.version).toBe('2');
      expect(pending.leaseToken).toBeNull();
      await db.query(
        'UPDATE ride_progress_jobs SET "availableAt"=clock_timestamp()',
      );
      const [fresh] = await claimRideProgress(db, 4);
      const completedQueries = jest.spyOn(db, 'query');
      try {
        await finishRideProgress(db, fresh, false);
        expect(completedQueries).toHaveBeenCalledTimes(1); // no redundant release
      } finally {
        completedQueries.mockRestore();
      }
      expect(await db.query('SELECT * FROM ride_progress_jobs')).toEqual([]);
    });

    it.each([
      ['gps', false], ['replacement', false], ['gps', true], ['replacement', true],
    ] as const)('finishing waits for a concurrent %s write and uses the locked version/lease (handoff=%s)', async (kind, handoff) => {
      const f = await fixture();
      await enqueueRideProgress(db, f.trip.id);
      const [job] = await claimRideProgress(db, 4);
      const next = handoff ? await fixture() : null;
      if (next) await enqueueRideProgress(db, next.trip.id);
      const writer = db.createQueryRunner(), finisher = db.createQueryRunner();
      let finishing: Promise<unknown> | undefined;
      try {
        await writer.connect(); await finisher.connect();
        await finisher.query("SET statement_timeout='8s'");
        const [{ pid }] = await finisher.query('SELECT pg_backend_pid() AS pid');
        await writer.startTransaction();
        if (kind === 'gps') await enqueueRideProgress(writer, f.trip.id);
        else await writer.query('UPDATE ride_progress_jobs SET "leaseToken"=$2 WHERE "tripId"=$1',
          [f.trip.id, '00000000-0000-4000-8000-000000000001']);
        finishing = handoff ? finishAndClaimRideProgress(finisher, job, false) : finishRideProgress(finisher, job, false);
        void finishing.catch(() => {});
        await waitForSqlLock(pid);
        await writer.commitTransaction();
        const successor = await finishing;
        if (handoff) {
          if (kind === 'gps') expect(successor).toMatchObject({ tripId: next!.trip.id });
          else {
            expect(successor).toBeUndefined();
            expect((await db.query('SELECT "leaseToken" FROM ride_progress_jobs WHERE "tripId"=$1', [next!.trip.id]))[0].leaseToken).toBeNull();
          }
        }
        const [row] = await db.query('SELECT * FROM ride_progress_jobs WHERE "tripId"=$1', [f.trip.id]);
        expect(row.version).toBe(kind === 'gps' ? '2' : '1');
        expect(row.leaseToken).toBe(kind === 'gps' ? null : '00000000-0000-4000-8000-000000000001');
      } finally {
        if (writer.isTransactionActive) await writer.rollbackTransaction();
        await finishing?.catch(() => {});
        await finisher.query('RESET statement_timeout');
        await finisher.release(); await writer.release();
      }
    });

    it('hands off competing slots to distinct jobs in one statement each without duplicating or prefetching', async () => {
      const first = await fixture(), second = await fixture();
      await enqueueRideProgress(db, first.trip.id); await enqueueRideProgress(db, second.trip.id);
      const jobs = await claimRideProgress(db, 2);
      const third = await fixture(), fourth = await fixture();
      await enqueueRideProgress(db, third.trip.id); await enqueueRideProgress(db, fourth.trip.id);
      const queries = jest.spyOn(db, 'query');
      let successors: Awaited<ReturnType<typeof finishAndClaimRideProgress>>[];
      try {
        successors = await Promise.all(jobs.map(job => finishAndClaimRideProgress(db, job, false)));
        expect(queries).toHaveBeenCalledTimes(2);
      } finally { queries.mockRestore(); }
      expect(new Set(successors!.map(job => job!.tripId))).toEqual(new Set([third.trip.id, fourth.trip.id]));
      expect(new Set(successors!.map(job => job!.leaseToken)).size).toBe(2);
      expect(await claimRideProgress(db, 4)).toEqual([]);
      expect((await db.query('SELECT count(*)::int AS n FROM ride_progress_jobs'))[0].n).toBe(2);
    });

    it('skips a locked successor without blocking the completed slot', async () => {
      const first = await fixture(); await enqueueRideProgress(db, first.trip.id);
      const [job] = await claimRideProgress(db, 1);
      const next = await fixture(); await enqueueRideProgress(db, next.trip.id);
      const blocker = db.createQueryRunner(), finisher = db.createQueryRunner();
      try {
        await blocker.startTransaction();
        await blocker.query('SELECT "tripId" FROM ride_progress_jobs WHERE "tripId"=$1 FOR UPDATE', [next.trip.id]);
        await finisher.connect(); await finisher.query("SET lock_timeout='250ms'");
        expect(await finishAndClaimRideProgress(finisher, job, false)).toBeUndefined();
        expect(await db.query('SELECT "tripId" FROM ride_progress_jobs WHERE "tripId"=$1', [first.trip.id])).toEqual([]);
        await blocker.commitTransaction();
        expect(await claimRideProgress(db, 1)).toEqual([expect.objectContaining({ tripId: next.trip.id })]);
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        await finisher.query('RESET lock_timeout');
        await finisher.release(); await blocker.release();
      }
    });

    it('rolls back acknowledgement when the successor claim fails', async () => {
      const first = await fixture(); await enqueueRideProgress(db, first.trip.id);
      const [job] = await claimRideProgress(db, 1);
      const next = await fixture(); await enqueueRideProgress(db, next.trip.id);
      // Existing leased rows remain, but a new claim must fail in this disposable DB.
      await db.query('ALTER TABLE ride_progress_jobs ADD CONSTRAINT test_reject_claim CHECK ("leaseToken" IS NULL) NOT VALID');
      try {
        await expect(finishAndClaimRideProgress(db, job, false)).rejects.toThrow('test_reject_claim');
        const rows = await db.query('SELECT * FROM ride_progress_jobs');
        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.tripId === first.trip.id).leaseToken).toBe(job.leaseToken);
        expect(rows.find(row => row.tripId === next.trip.id).leaseToken).toBeNull();
      } finally { await db.query('ALTER TABLE ride_progress_jobs DROP CONSTRAINT test_reject_claim'); }
    });

    it.each([1000, 5000] as const)('hands a failed slot onward while preserving its %s ms recovery delay', async delay => {
      const first = await fixture(); await enqueueRideProgress(db, first.trip.id);
      const [job] = await claimRideProgress(db, 1);
      const next = await fixture(); await enqueueRideProgress(db, next.trip.id);
      expect(await finishAndClaimRideProgress(db, job, true, delay)).toMatchObject({ tripId: next.trip.id });
      const [row] = await db.query('SELECT *, EXTRACT(EPOCH FROM ("availableAt"-clock_timestamp()))*1000 AS remaining FROM ride_progress_jobs WHERE "tripId"=$1', [first.trip.id]);
      expect(row.leaseToken).toBeNull(); expect(row.version).toBe(job.version);
      expect(Number(row.remaining)).toBeGreaterThan(delay - 500);
      expect(Number(row.remaining)).toBeLessThanOrEqual(delay);
    });

    it('queued pickup and proximity pushes become obsolete after dropoff; unrelated users never receive ride events', async () => {
      const f = await fixture();
      const booking = await db
        .getRepository(Booking)
        .findOneByOrFail({ tripId: f.trip.id, passengerId: f.accepted.id });
      const notice = db.getRepository(Notification).create({
        userId: f.accepted.id,
        data: {
          type: 'pickup_confirmed_automatically',
          tripId: f.trip.id,
          bookingId: booking.id,
        },
      });
      expect(await isRideProgressDeliverable(db.manager, notice)).toBe(false);
      await db
        .getRepository(Trip)
        .update(f.trip.id, { status: TripStatus.ACTIVE });
      await db.getRepository(Booking).update(booking.id, { pickedUp: true });
      for (const type of [
        'pickup_confirmed_automatically',
        'destination_proximity',
        'passenger_destination_proximity',
      ]) {
        notice.data!.type = type;
        expect(await isRideProgressDeliverable(db.manager, notice)).toBe(true);
        expect(
          await isRideProgressDeliverable(db.manager, {
            ...notice,
            userId: f.stranger.id,
          }),
        ).toBe(false);
      }
      await db
        .getRepository(Booking)
        .update(booking.id, {
          status: BookingStatus.COMPLETED,
          droppedOff: true,
        });
      expect(await isRideProgressDeliverable(db.manager, notice)).toBe(false);
      notice.data!.type = 'dropoff_confirmed_automatically';
      expect(await isRideProgressDeliverable(db.manager, notice)).toBe(true);
    });

    it('expired worker recovers after restart; stale completion cannot delete its replacement and failure backs off', async () => {
      const f = await fixture();
      await enqueueRideProgress(db, f.trip.id);
      const [stale] = await claimRideProgress(db, 4);
      await db.query(
        'UPDATE ride_progress_jobs SET "leaseUntil"=clock_timestamp()-interval \'1 second\'',
      );
      const [replacement] = await claimRideProgress(db, 4);
      expect(replacement.leaseToken).not.toBe(stale.leaseToken);
      await finishRideProgress(db, stale, false);
      expect(
        (await db.query('SELECT "leaseToken" FROM ride_progress_jobs'))[0]
          .leaseToken,
      ).toBe(replacement.leaseToken);
      await finishRideProgress(db, replacement, true);
      expect(await claimRideProgress(db, 4)).toEqual([]);
      const [row] = await db.query(
        'SELECT "availableAt">clock_timestamp() AS delayed FROM ride_progress_jobs',
      );
      expect(row.delayed).toBe(true);
    });

    it('maintenance has one cross-replica owner, respects interval and allows crash recovery', async () => {
      let release!: () => void;
      const work = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const first = runExclusiveMaintenanceJob(db, 'test', 300000, work);
      // Wait until the callback is reached, not for an arbitrary database delay.
      while (!release)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        await runExclusiveMaintenanceJob(db, 'test', 300000, work),
      ).toBeNull();
      release();
      await first;
      expect(
        await runExclusiveMaintenanceJob(db, 'test', 300000, work),
      ).toBeNull();
      expect(work).toHaveBeenCalledTimes(1);
      await db.query(
        `UPDATE maintenance_job_leases SET "leaseUntil"=clock_timestamp()-interval '1 second', "nextRunAt"=clock_timestamp()`,
      );
      expect(
        await runExclusiveMaintenanceJob(
          db,
          'test',
          300000,
          async () => 'recovered',
        ),
      ).toBe('recovered');
    });

    it('rollback refuses to drop pending GPS jobs; clean rollback and reapply succeed', async () => {
      const f = await fixture(),
        runner = db.createQueryRunner();
      try {
        await enqueueRideProgress(db, f.trip.id);
        await expect(
          new PerformanceWorkQueues1780000135000().down(runner),
        ).rejects.toThrow('Drain ride progress jobs');
        await db.getRepository(Booking).delete({ tripId: f.trip.id });
        await db.getRepository(Trip).delete(f.trip.id); // FK cascade only for the removed trip
        expect(await db.query('SELECT * FROM ride_progress_jobs')).toEqual([]);
        await new PerformanceWorkQueues1780000135000().down(runner);
        await new PerformanceWorkQueues1780000135000().up(runner);
      } finally {
        await runner.release();
      }
    });
  },
);
