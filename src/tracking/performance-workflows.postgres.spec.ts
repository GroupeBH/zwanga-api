import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { PerformanceWorkQueues1780000135000 } from '../database/migrations/1780000135000-PerformanceWorkQueues';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripsService } from '../trips/trips.service';
import { User } from '../users/entities/user.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { enqueueTripStartNotifications } from '../trips/trip-start-notifications';
import { isTripStartDeliverable } from '../notifications/trip-start-delivery';
import { isRideProgressDeliverable } from '../notifications/ride-progress-delivery';
import { runExclusiveMaintenanceJob } from '../common/exclusive-maintenance-job';
import {
  claimRideProgress,
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
      await finishRideProgress(db, jobs[0], false);
      const [pending] = await db.query('SELECT * FROM ride_progress_jobs');
      expect(pending.version).toBe('2');
      expect(pending.leaseToken).toBeNull();
      await db.query(
        'UPDATE ride_progress_jobs SET "availableAt"=clock_timestamp()',
      );
      const [fresh] = await claimRideProgress(db, 4);
      await finishRideProgress(db, fresh, false);
      expect(await db.query('SELECT * FROM ride_progress_jobs')).toEqual([]);
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
