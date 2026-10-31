import { randomUUID } from 'crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { expirePendingTrip } from '../trips/expire-pending-trip';
import { savePublicationsWithPhotoPolicy } from '../trips/trip-publication-photo';
import { withBookableTrip } from '../bookings/bookable-trip-transaction';
import { BookingsService } from '../bookings/bookings.service';
import { enqueueTripReminder } from '../trips/trip-reminders';
import { Notification } from '../notifications/entities/notification.entity';
import { SafetyAlert, SafetyAlertStatus, SafetyAlertType } from '../safety/entities/safety-alert.entity';
import { EmergencyContact } from '../safety/entities/emergency-contact.entity';
import { createPhoneShutdownAlert } from '../safety/phone-shutdown-alert';
import { TripRequest, TripRequestStatus } from '../trip-requests/entities/trip-request.entity';

const bin = process.env.RESILIENCE_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'resilience on isolated PostgreSQL (no application configuration)',
  () => {
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    const now = new Date('2026-10-14T12:00:00Z');
    const cutoff = new Date('2026-10-14T10:00:00Z');
    beforeAll(async () => {
      const base = await cluster.start();
      db = await new DataSource({
        ...base.options,
        synchronize: true,
        entities: [
          new EntitySchema<Trip>({
            name: 'Trip',
            target: Trip,
            tableName: 'trips',
            columns: {
              id: {
                type: 'uuid',
                primary: true,
                default: () => 'gen_random_uuid()',
              },
              driverId: { type: 'uuid' },
              isPrivate: { type: Boolean, default: false },
              status: { type: String },
              departureDate: { type: 'timestamptz' },
              estimatedArrivalDate: { type: 'timestamp', nullable: true },
              tripRequestId: { type: 'varchar', nullable: true },
              startedAt: { type: 'timestamptz', nullable: true },
              completedAt: { type: 'timestamptz', nullable: true },
              availableSeats: { type: Number },
              totalSeats: { type: Number },
              departureReminderNotified: { type: Boolean, default: false },
              departureLocation: { type: String, default: 'Départ' },
              arrivalLocation: { type: String, default: 'Arrivée' },
              recurringTemplateId: { type: 'uuid', nullable: true },
              recurringOccurrenceDate: { type: 'date', nullable: true },
            },
          }),
          // Minimal schedule tables used by the real publication guard. Keep
          // UUID owners and legacy varchar trip references aligned with production.
          new EntitySchema<TripRequest>({
            name: 'TripRequest', target: TripRequest, tableName: 'trip_requests',
            columns: {
              id: { type: 'uuid', primary: true },
              // TypeORM resolves the User join column to UUID.
              selectedDriverId: { type: 'uuid', nullable: true },
              tripId: { type: 'varchar', nullable: true },
              status: { type: String },
              departureDateMin: { type: 'timestamp' },
              departureDateMax: { type: 'timestamp' },
            },
          }),
          new EntitySchema({
            name: 'DispatchScheduleReservation', tableName: 'trip_request_dispatch_offers',
            columns: {
              id: { type: 'uuid', primary: true },
              requestId: { type: 'uuid' },
              driverId: { type: 'uuid' },
              status: { type: String },
              phase: { type: String },
            },
          }),
          new EntitySchema<Booking>({
            name: 'Booking',
            target: Booking,
            tableName: 'bookings',
            columns: {
              id: { type: 'uuid', primary: true },
              tripId: { type: 'uuid' },
              status: { type: String },
              numberOfSeats: { type: Number },
              passengerId: { type: 'uuid', nullable: true },
              firstTripSubsidyApplied: { type: Boolean, default: false },
              grossPaymentAmount: { type: Number, nullable: true },
              paymentAmount: { type: Number, nullable: true },
              passengerPaymentRate: { type: Number, nullable: true },
              zwangaSubsidyAmount: { type: Number, nullable: true },
            },
          }),
          new EntitySchema<User>({
            name: 'User',
            target: User,
            tableName: 'users',
            columns: {
              id: { type: 'uuid', primary: true },
              profilePicture: { type: String },
              hasPublishedTrip: { type: Boolean },
            },
          }),
          new EntitySchema<Notification>({
            name: 'Notification', target: Notification, tableName: 'notifications',
            columns: {
              id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
              eventKey: { type: String, unique: true }, userId: { type: 'uuid' },
              title: { type: String }, body: { type: String }, data: { type: 'jsonb' },
              fcmToken: { type: String }, isAutomatic: { type: Boolean },
              status: { type: String }, errorMessage: { type: String, nullable: true },
            },
          }),
          new EntitySchema<SafetyAlert>({
            name: 'SafetyAlert', target: SafetyAlert, tableName: 'safety_alerts',
            columns: {
              id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
              userId: { type: 'uuid' }, tripId: { type: 'uuid', nullable: true },
              bookingId: { type: 'uuid', nullable: true }, type: { type: String },
              status: { type: String }, message: { type: String, nullable: true },
              latitude: { type: Number, nullable: true }, longitude: { type: Number, nullable: true },
              batteryLevel: { type: Number, nullable: true },
              lastLocationUpdate: { type: 'timestamptz', nullable: true },
            },
          }),
          new EntitySchema<EmergencyContact>({
            name: 'EmergencyContact', target: EmergencyContact, tableName: 'emergency_contacts',
            columns: {
              id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
              userId: { type: 'uuid' }, isActive: { type: Boolean, default: true },
            },
          }),
        ],
      }).initialize();
    }, 120000);
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      await cluster.stop();
    }, 40000);
    beforeEach(async () => {
      await db.query('TRUNCATE bookings, trips, users, notifications, safety_alerts, emergency_contacts, trip_request_dispatch_offers, trip_requests');
    });
    async function setup() {
      const driverId = randomUUID();
      await db
        .getRepository(User)
        .save({
          id: driverId,
          profilePicture: 'test.jpg',
          hasPublishedTrip: true,
        });
      const trip = await db
        .getRepository(Trip)
        .save({
          driverId,
          status: TripStatus.PENDING,
          departureDate: new Date('2026-10-14T08:00:00Z'),
          totalSeats: 4,
          availableSeats: 2,
        });
      await db.getRepository(Booking).save([
        {
          id: randomUUID(),
          tripId: trip.id,
          status: BookingStatus.ACCEPTED,
          numberOfSeats: 2,
          passengerId: randomUUID(),
        },
        {
          id: randomUUID(),
          tripId: trip.id,
          status: BookingStatus.PENDING,
          numberOfSeats: 3,
          passengerId: randomUUID(),
        },
      ]);
      return trip;
    }
    it('two cron workers expire once, restore only consumed seats and cannot exceed capacity', async () => {
      const trip = await setup();
      const results = await Promise.all(
        [1, 2].map(() =>
          expirePendingTrip(db.getRepository(Trip), trip.id, cutoff, now),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        await db.getRepository(Trip).findOneByOrFail({ id: trip.id }),
      ).toMatchObject({ status: TripStatus.COMPLETED, availableSeats: 4 });
      expect(
        (await db.getRepository(Booking).find()).every(
          (booking) => booking.status === BookingStatus.EXPIRED,
        ),
      ).toBe(true);
      expect(
        await expirePendingTrip(db.getRepository(Trip), trip.id, cutoff, now),
      ).toBeNull();
    });
    it('a committed concurrent start cannot be overwritten by a stale expiry candidate', async () => {
      const trip = await setup();
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.manager
          .getRepository(Trip)
          .update(trip.id, { status: TripStatus.ACTIVE, startedAt: now });
        const expiry = expirePendingTrip(
          db.getRepository(Trip),
          trip.id,
          cutoff,
          now,
        );
        await runner.commitTransaction();
        expect(await expiry).toBeNull();
        expect(
          await db.getRepository(Trip).findOneByOrFail({ id: trip.id }),
        ).toMatchObject({ status: TripStatus.ACTIVE, availableSeats: 2 });
        expect(
          await db
            .getRepository(Booking)
            .countBy({ status: BookingStatus.ACCEPTED }),
        ).toBe(1);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    });
    it('rolls back trip expiry and seats if a booking transition fails', async () => {
      const trip = await setup();
      await db.query(
        `ALTER TABLE bookings ADD CONSTRAINT test_no_expiry CHECK (status <> 'expired')`,
      );
      try {
        await expect(
          expirePendingTrip(db.getRepository(Trip), trip.id, cutoff, now),
        ).rejects.toThrow();
        expect(
          await db.getRepository(Trip).findOneByOrFail({ id: trip.id }),
        ).toMatchObject({
          status: TripStatus.PENDING,
          availableSeats: 2,
          completedAt: null,
        });
      } finally {
        await db.query('ALTER TABLE bookings DROP CONSTRAINT test_no_expiry');
      }
    });
    it('concurrent recurring publication rechecks occurrence under the same driver lock', async () => {
      const trip = await setup();
      const recurringTemplateId = randomUUID();
      const create = () =>
        db
          .getRepository(Trip)
          .create({
            driverId: trip.driverId,
            isPrivate: false,
            status: TripStatus.PENDING,
            totalSeats: 4,
            availableSeats: 4,
            departureDate: now,
            recurringTemplateId,
            recurringOccurrenceDate: '2026-10-15',
          });
      const results = await Promise.all(
        [1, 2].map(() =>
          savePublicationsWithPhotoPolicy(
            db.getRepository(Trip),
            trip.driverId,
            [create()],
          ),
        ),
      );
      expect(results.flat()).toHaveLength(1);
      expect(
        await db.getRepository(Trip).countBy({ recurringTemplateId }),
      ).toBe(1);
      expect(
        await savePublicationsWithPhotoPolicy(
          db.getRepository(Trip),
          trip.driverId,
          [create()],
        ),
      ).toEqual([]);
    });
    it.each(['selected', 'preparing'] as const)(
      'does not publish over an overlapping %s request reservation',
      async (phase) => {
        const trip = await setup();
        const requestId = randomUUID();
        await db.getRepository(TripRequest).save({
          id: requestId,
          selectedDriverId: phase === 'selected' ? trip.driverId : null,
          status: phase === 'selected' ? TripRequestStatus.DRIVER_SELECTED : TripRequestStatus.PENDING,
          departureDateMin: now,
          departureDateMax: now,
        });
        if (phase === 'preparing') {
          await db.query(`INSERT INTO trip_request_dispatch_offers (id,"requestId","driverId",status,phase)
            VALUES ($1,$2,$3,'pending','accepting')`, [randomUUID(), requestId, trip.driverId]);
        }
        const candidate = db.getRepository(Trip).create({
          driverId: trip.driverId, isPrivate: false, status: TripStatus.PENDING,
          departureDate: now, totalSeats: 4, availableSeats: 4,
          recurringTemplateId: randomUUID(), recurringOccurrenceDate: '2026-10-14',
        });
        await expect(savePublicationsWithPhotoPolicy(db.getRepository(Trip), trip.driverId, [candidate]))
          .rejects.toMatchObject({ response: { code: 'DRIVER_SCHEDULE_CONFLICT' } });
        expect(await db.getRepository(Trip).countBy({ recurringTemplateId: candidate.recurringTemplateId! })).toBe(0);
      },
    );
    it('rejects a stale booking request after expiry commits', async () => {
      const trip = await setup();
      await expirePendingTrip(db.getRepository(Trip), trip.id, cutoff, now);
      const save = jest.fn();
      await expect(withBookableTrip(db.getRepository(Trip), trip.id, 1, save)).rejects.toThrow('plus disponible');
      expect(save).not.toHaveBeenCalled();
      expect(await db.getRepository(Booking).countBy({ status: BookingStatus.PENDING })).toBe(0);
    });
    it('expiry waits for an in-flight insert and includes it in its booking snapshot', async () => {
      const trip = await setup();
      let entered!: () => void, release!: () => void;
      const inserted = new Promise<void>(resolve => { entered = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      const id = randomUUID();
      const creation = withBookableTrip(db.getRepository(Trip), trip.id, 1, async manager => {
        await manager.save(Booking, { id, tripId: trip.id, status: BookingStatus.PENDING, numberOfSeats: 1 });
        entered();
        await resume;
      });
      await inserted;
      const expiration = expirePendingTrip(db.getRepository(Trip), trip.id, cutoff, now);
      release();
      await Promise.all([creation, expiration]);
      expect(await db.getRepository(Booking).findOneByOrFail({ id })).toMatchObject({ status: BookingStatus.EXPIRED });
    });
    it('deduplicates concurrent reminders and only changes the reminder flag', async () => {
      const trip = await setup();
      await db.getRepository(Trip).update(trip.id, { departureDate: new Date(now.getTime() + 20 * 60_000) });
      const results = await Promise.all([1, 2].map(() => enqueueTripReminder(db.getRepository(Trip), trip.id, 'departure', now)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await db.getRepository(Notification).count()).toBe(2);
      expect(await db.getRepository(Trip).findOneByOrFail({ id: trip.id })).toMatchObject({
        status: TripStatus.PENDING, startedAt: null, availableSeats: 2, departureReminderNotified: true,
      });
      await Promise.all([1, 2].map(() => enqueueTripReminder(db.getRepository(Trip), trip.id, 'expiration', now)));
      expect(await db.getRepository(Notification).count()).toBe(4);
    });
    it('a stale reminder cannot resurrect a started trip', async () => {
      const trip = await setup();
      await db.getRepository(Trip).update(trip.id, {
        departureDate: new Date(now.getTime() + 20 * 60_000), status: TripStatus.ACTIVE, startedAt: now,
      });
      expect(await enqueueTripReminder(db.getRepository(Trip), trip.id, 'departure', now)).toBe(false);
      expect(await db.getRepository(Trip).findOneByOrFail({ id: trip.id })).toMatchObject({ status: TripStatus.ACTIVE, startedAt: now });
      expect(await db.getRepository(Notification).count()).toBe(0);
    });
    it('rolls back the reminder flag if outbox insertion fails', async () => {
      const trip = await setup();
      await db.getRepository(Trip).update(trip.id, { departureDate: new Date(now.getTime() + 20 * 60_000) });
      await db.query('ALTER TABLE notifications ADD CONSTRAINT test_no_notification CHECK (false)');
      try {
        await expect(enqueueTripReminder(db.getRepository(Trip), trip.id, 'departure', now)).rejects.toThrow();
        expect((await db.getRepository(Trip).findOneByOrFail({ id: trip.id })).departureReminderNotified).toBe(false);
      } finally { await db.query('ALTER TABLE notifications DROP CONSTRAINT test_no_notification'); }
      expect(await enqueueTripReminder(db.getRepository(Trip), trip.id, 'departure', now)).toBe(true);
    });
    it('two safety workers create one alert and one durable notification for the same scope', async () => {
      const trip = await setup();
      await db.getRepository(Trip).update(trip.id, { status: TripStatus.ACTIVE, startedAt: now });
      await db.getRepository(EmergencyContact).save({ userId: trip.driverId });
      const repository = db.getRepository(SafetyAlert);
      const candidates = await repository.save([1, 2].map(() => ({
        userId: trip.driverId, tripId: trip.id, bookingId: null,
        type: SafetyAlertType.LOW_BATTERY, status: SafetyAlertStatus.ACTIVE,
        lastLocationUpdate: new Date(now.getTime() - 10 * 60_000),
      })));
      const results = await Promise.all(candidates.map(candidate => createPhoneShutdownAlert(repository, candidate, now, 5 * 60_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repository.countBy({ type: SafetyAlertType.PHONE_SHUTDOWN })).toBe(1);
      expect(await db.getRepository(Notification).count()).toBe(1);
    });
    it('rechecks fresh telemetry before creating a shutdown alert', async () => {
      const trip = await setup();
      const repository = db.getRepository(SafetyAlert);
      const candidate = await repository.save({ userId: trip.driverId, tripId: trip.id,
        type: SafetyAlertType.LOW_BATTERY, status: SafetyAlertStatus.ACTIVE,
        lastLocationUpdate: new Date(now.getTime() - 10 * 60_000) });
      await repository.update(candidate.id, { lastLocationUpdate: now });
      expect(await createPhoneShutdownAlert(repository, candidate, now, 5 * 60_000)).toBe(false);
      expect(await repository.countBy({ type: SafetyAlertType.PHONE_SHUTDOWN })).toBe(0);
    });
    it('keeps the outer booking transaction usable after a first-subsidy uniqueness conflict', async () => {
      const trip = await setup(), passengerId = randomUUID();
      await db.query('CREATE UNIQUE INDEX test_one_subsidy ON bookings ("passengerId") WHERE "firstTripSubsidyApplied"');
      try {
        await db.getRepository(Booking).save({ id: randomUUID(), tripId: trip.id, passengerId,
          status: BookingStatus.PENDING, numberOfSeats: 1, firstTripSubsidyApplied: true });
        const booking = db.getRepository(Booking).create({ id: randomUUID(), tripId: trip.id, passengerId,
          status: BookingStatus.PENDING, numberOfSeats: 1, firstTripSubsidyApplied: true,
          paymentAmount: 4000, grossPaymentAmount: 10000, zwangaSubsidyAmount: 6000 });
        const service: any = Object.create(BookingsService.prototype);
        service.logger = { warn: jest.fn() };
        const saved = await withBookableTrip(db.getRepository(Trip), trip.id, 1, manager =>
          service.saveBookingWithFirstTripSubsidyRaceFallback(booking, trip, manager));
        expect(saved).toMatchObject({ firstTripSubsidyApplied: false, paymentAmount: 10000 });
        expect(await db.getRepository(Booking).findOneByOrFail({ id: booking.id })).toMatchObject({
          firstTripSubsidyApplied: false, paymentAmount: 10000,
        });
      } finally { await db.query('DROP INDEX test_one_subsidy'); }
    });
  },
);
