import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';
import { cancelBookingBeforePickup } from './cancel-booking';
import { RideDeclarationsService } from '../ride-declarations/ride-declarations.service';
import { UniqueFlexPayOrder1780000142000 } from '../database/migrations/1780000142000-UniqueFlexPayOrder';
import {
  assertNoSubsidyPayoutHold,
  hasSubsidyPayoutHold,
  WITHDRAWABLE_EARNINGS_SUM_SQL,
} from '../driver-settlements/subsidy-payout-guard';
import { BookingResponseInterceptor } from './booking-response.interceptor';

// Explicit local disposable cluster; no .env, production URL, external payment or notification.
const bin = process.env.SECURITY_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'booking/payment security on PostgreSQL',
  () => {
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    const tripId = randomUUID(),
      bookingId = randomUUID(),
      passengerId = randomUUID(),
      driverId = randomUUID();
    const nullableTime = { type: 'timestamptz' as const, nullable: true };
    const boolean = { type: Boolean, default: false };
    const geo = {
      type: 'geography' as const,
      spatialFeatureType: 'Point',
      srid: 4326,
      nullable: true,
    };
    beforeAll(async () => {
      const base = await cluster.start();
      await base.query('CREATE EXTENSION IF NOT EXISTS postgis');
      db = await new DataSource({
        ...base.options,
        synchronize: true,
        entities: [
          new EntitySchema({
            name: 'Trip',
            target: Trip,
            tableName: 'trips',
            columns: {
              id: { type: 'uuid', primary: true },
              driverId: { type: 'uuid' },
              tripRequestId: { type: String, nullable: true },
              status: { type: String },
              departureDate: nullableTime,
              startedAt: nullableTime,
              currentLocation: geo,
              lastLocationUpdateAt: nullableTime,
            },
          }),
          new EntitySchema({
            name: 'Booking',
            target: Booking,
            tableName: 'bookings',
            columns: {
              id: { type: 'uuid', primary: true },
              tripId: { type: 'uuid' },
              passengerId: { type: 'uuid' },
              status: { type: String },
              pickedUp: boolean,
              droppedOff: boolean,
              pickedUpConfirmedByPassenger: boolean,
              droppedOffConfirmedByPassenger: boolean,
              pickedUpAt: nullableTime,
              droppedOffAt: nullableTime,
              pickedUpConfirmedAt: nullableTime,
              droppedOffConfirmedAt: nullableTime,
              cancelledAt: nullableTime,
              pickupDetectionMethod: { type: String, nullable: true },
              dropoffDetectionMethod: { type: String, nullable: true },
              passengerCurrentLocation: geo,
              passengerLastLocationUpdateAt: nullableTime,
              rideDeclarations: {
                type: 'jsonb',
                select: false,
                default: () => "'{}'::jsonb",
              },
              rideEffectsPending: {
                type: 'jsonb',
                select: false,
                default: () => "'[]'::jsonb",
              },
              rideEffectsVersion: { type: Number, select: false, default: 0 },
              rideEffectsRetryAt: nullableTime,
              paymentStatus: { type: String, default: 'pending' },
              firstTripSubsidyApplied: boolean,
              paymentCurrency: { type: String, nullable: true },
              zwangaSubsidyAmount: { type: 'numeric', nullable: true },
            },
            relations: {
              trip: {
                type: 'many-to-one',
                target: 'Trip',
                joinColumn: { name: 'tripId' },
              },
            },
          }),
        ],
      }).initialize();
      await db.query(`CREATE TABLE payment_transactions (id uuid PRIMARY KEY, provider text, "orderNumber" text);
      CREATE TABLE driver_earnings (id uuid PRIMARY KEY,"driverId" uuid,"bookingId" uuid,status text,currency text,
        "netAmount" numeric DEFAULT 6000000,"assetRepaymentAmount" numeric DEFAULT 0,
        "proRepaymentAmount" numeric DEFAULT 0,"proCreditPending" boolean DEFAULT false)`);
    }, 90000);
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      await cluster.stop();
    });
    beforeEach(async () => {
      await db.query(
        'TRUNCATE driver_earnings, payment_transactions, bookings, trips CASCADE',
      );
      await db.getRepository(Trip).save({
        id: tripId,
        driverId,
        tripRequestId: randomUUID(),
        status: 'ongoing',
        startedAt: new Date(),
        departureDate: new Date(),
      } as Trip);
      await db.getRepository(Booking).save({
        id: bookingId,
        tripId,
        passengerId,
        status: BookingStatus.ACCEPTED,
      } as Booking);
    });
    const cancel = () =>
      cancelBookingBeforePickup(
        db.getRepository(Booking),
        bookingId,
        passengerId,
        () => undefined,
      );
    const declarations = () =>
      new RideDeclarationsService(db, {
        invalidateManualRideCaches: async () => undefined,
        validateManualRidePassenger: async () => undefined,
      } as any);
    const pickup = () =>
      declarations().declare(bookingId, driverId, {
        eventId: randomUUID(),
        actorUserId: driverId,
        stage: 'pickup',
        decision: 'confirm',
        occurredAt: new Date().toISOString(),
      });

    it('refuses cancellation after a real driver pickup declaration', async () => {
      await pickup();
      await expect(cancel()).rejects.toMatchObject({
        response: { code: 'BOOKING_ALREADY_BOARDED' },
      });
      expect(
        (await db.getRepository(Booking).findOneByOrFail({ id: bookingId }))
          .status,
      ).toBe('accepted');
    });
    it('refuses pickup after a committed cancellation and does not cancel twice', async () => {
      await cancel();
      await expect(pickup()).rejects.toThrow();
      await expect(cancel()).rejects.toThrow();
    });
    it('allows only one outcome when pickup and cancellation compete', async () => {
      const results = await Promise.allSettled([pickup(), cancel()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const b = await db
        .getRepository(Booking)
        .findOneByOrFail({ id: bookingId });
      expect(b.status === 'cancelled' && b.pickedUp).toBe(false);
    });
    it('reads fresh permissions and geometry when sanitizing a cached HTTP response', async () => {
      await db.query(
        `UPDATE trips SET "currentLocation"=ST_SetSRID(ST_Point(15.3,-4.3),4326),"lastLocationUpdateAt"=now() WHERE id=$1`,
        [tripId],
      );
      const raw: any = {
        ...(await db.getRepository(Booking).findOneByOrFail({ id: bookingId })),
        trip: {
          driver: {
            id: driverId,
            fcmToken: 'private-push',
            phone: 'private-phone',
          },
        },
      };
      const presenter = new BookingResponseInterceptor(
        db.getRepository(Booking),
      );
      const live: any = await presenter.present(raw, passengerId);
      expect(live.trip.currentLocation.coordinates).toEqual([15.3, -4.3]);
      await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [
        bookingId,
      ]);
      const cancelled: any = await presenter.present(raw, passengerId);
      expect(cancelled.trip.currentLocation).toBeNull();
      expect(JSON.stringify(cancelled)).not.toContain('private-phone');
      expect(JSON.stringify(cancelled)).not.toContain('private-push');
    });
    it('holds legacy over-cap earnings for all withdrawal paths without changing the booking', async () => {
      await db.query(
        `UPDATE bookings SET "firstTripSubsidyApplied"=true,"paymentCurrency"='CDF',"zwangaSubsidyAmount"=6000000 WHERE id=$1`,
        [bookingId],
      );
      await db.query(
        `INSERT INTO driver_earnings (id,"driverId","bookingId",status,currency) VALUES ($1,$2,$3,'available','CDF')`,
        [randomUUID(), driverId, bookingId],
      );
      await expect(
        assertNoSubsidyPayoutHold(db.manager, driverId),
      ).rejects.toMatchObject({
        response: { code: 'SUBSIDY_PAYOUT_REVIEW_REQUIRED' },
      });
      // The same-statement guard also excludes earnings created AFTER an
      // earlier hold check, without relying on a second application-level read.
      const sum = () =>
        db.query<{ sum: string }[]>(
          `SELECT ${WITHDRAWABLE_EARNINGS_SUM_SQL} AS sum FROM driver_earnings earning WHERE earning."driverId"=$1`,
          [driverId],
        );
      expect(Number((await sum())[0].sum)).toBe(0);
      expect(
        Number(
          (
            await db.query(
              'SELECT "zwangaSubsidyAmount" FROM bookings WHERE id=$1',
              [bookingId],
            )
          )[0].zwangaSubsidyAmount,
        ),
      ).toBe(6000000);
      await db.query(
        'UPDATE bookings SET "zwangaSubsidyAmount"=7500 WHERE id=$1',
        [bookingId],
      );
      expect(await hasSubsidyPayoutHold(db.manager, driverId)).toBe(false);
      await db.query(
        'UPDATE driver_earnings SET "netAmount"=7500 WHERE "bookingId"=$1',
        [bookingId],
      );
      expect(Number((await sum())[0].sum)).toBe(7500);
      await db.query(
        `UPDATE bookings SET "paymentCurrency"='USD' WHERE id=$1`,
        [bookingId],
      );
      expect(await hasSubsidyPayoutHold(db.manager, driverId)).toBe(true);
    });
    it('refuses an order-index migration with duplicates, without deleting financial history', async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        await db.query('DROP INDEX IF EXISTS "UQ_flexpay_provider_order"');
        await db.query(
          `INSERT INTO payment_transactions VALUES ($1,'flexpay','duplicate'),($2,'flexpay','duplicate')`,
          [randomUUID(), randomUUID()],
        );
        await expect(
          new UniqueFlexPayOrder1780000142000().up(runner),
        ).rejects.toThrow('FLEXPAY_DUPLICATE_ORDERS');
        expect(
          Number(
            (await db.query('SELECT count(*) FROM payment_transactions'))[0]
              .count,
          ),
        ).toBe(2);
      } finally {
        await runner.release();
      }
    });
    it('permits only one simultaneous binding of a FlexPay provider order', async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        await new UniqueFlexPayOrder1780000142000().up(runner);
      } finally {
        await runner.release();
      }
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          db.query(
            `INSERT INTO payment_transactions VALUES ($1,'flexpay','same-order')`,
            [randomUUID()],
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(failed.reason.code).toBe('23505');
      await db.query(
        `INSERT INTO payment_transactions VALUES ($1,'pawapay','same-order'),($2,'flexpay',null),($3,'flexpay',null)`,
        [randomUUID(), randomUUID(), randomUUID()],
      );
    });
  },
);
