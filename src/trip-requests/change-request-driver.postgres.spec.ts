import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { AddDriverDispatch1780000048000 } from '../database/migrations/1780000048000-AddDriverDispatch';
import { NearbyRequestRingingCooldown1780000087000 } from '../database/migrations/1780000087000-NearbyRequestRingingCooldown';
import { RememberDriverRequestRefusals1780000095000 } from '../database/migrations/1780000095000-RememberDriverRequestRefusals';
import { RequestResponsePhases1780000098000 } from '../database/migrations/1780000098000-RequestResponsePhases';
import { PassengerDriverChangeReason1780000102000 } from '../database/migrations/1780000102000-PassengerDriverChangeReason';
import { User } from '../users/entities/user.entity';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { saveRequestTrip } from '../trips/save-request-trip';
import { BookingsService } from '../bookings/bookings.service';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { claimBookingPayment } from '../payments/booking-payment-claim';
import { Notification } from '../notifications/entities/notification.entity';
import * as outbox from '../notifications/transactional-notification';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { changeRequestDriver } from './change-request-driver';
import { hasRefusedRequest } from './request-refusal';
import { recoverRequestAcceptance } from './dispatch/request-acceptance';
import { SharedTripOffersService } from './shared-trip-offers.service';

// Fresh local PostgreSQL only. The existing CI opt-in already covers this suite.
const bin = process.env.DISPATCH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'passenger driver change on isolated PostgreSQL',
  () => {
    jest.setTimeout(180000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource;
    let isolation: { restore(): void; count(): number } | undefined;
    const bookings = Object.create(
      BookingsService.prototype,
    ) as BookingsService;
    beforeAll(async () => {
      Logger.overrideLogger(false);
      db = await cluster.start();
      isolation = require('../../test/load/isolation.cjs').restrictConnections([
        (db.options as { port: number }).port,
      ]);
      db.setOptions({ entities: typeOrmEntities });
      await (
        db as unknown as { buildMetadatas(): Promise<void> }
      ).buildMetadatas();
      await db.query('CREATE EXTENSION postgis; CREATE EXTENSION "uuid-ossp"');
      await db.synchronize();
      await db.query(
        'ALTER TABLE trip_requests DROP COLUMN "immediateDispatch"',
      );
      await db.transaction(async (manager) => {
        for (const migration of [
          new AddDriverDispatch1780000048000(),
          new NearbyRequestRingingCooldown1780000087000(),
          new RememberDriverRequestRefusals1780000095000(),
          new RequestResponsePhases1780000098000(),
          new PassengerDriverChangeReason1780000102000(),
        ])
          await migration.up(manager.queryRunner!);
      });
    });
    afterEach(() => {
      jest.restoreAllMocks();
      if (isolation) expect(isolation.count()).toBe(0);
    });
    afterAll(async () => {
      isolation?.restore();
      await cluster.stop();
    });

    async function fixture(withTrip = true) {
      const passenger = await db
        .getRepository(User)
        .save({ firstName: 'Test', lastName: 'Passenger' });
      const driver = await db
        .getRepository(User)
        .save({ firstName: 'Test', lastName: 'Driver' });
      const request = await db.getRepository(TripRequest).save({
        passengerId: passenger.id,
        status: TripRequestStatus.DRIVER_SELECTED,
        selectedDriverId: driver.id,
        selectedAt: new Date(),
        targetDriverId: driver.id,
        departureLocation: 'A',
        arrivalLocation: 'B',
        departurePoint: { type: 'Point', coordinates: [15.31, -4.3] },
        departureDateMin: new Date(Date.now() + 3600_000),
        departureDateMax: new Date(Date.now() + 7200_000),
        numberOfSeats: 1,
        maxPricePerSeat: 5000,
        vehicleType: VehicleType.CAR,
        paymentMode: TripPaymentMode.ELECTRONIC,
      });
      const offer = await db.getRepository(DriverOffer).save({
        tripRequestId: request.id,
        driverId: driver.id,
        proposedDepartureDate: request.departureDateMin,
        pricePerSeat: 5000,
        availableSeats: 4,
        status: DriverOfferStatus.ACCEPTED,
      });
      const trip = withTrip
        ? await db.getRepository(Trip).save({
            driverId: driver.id,
            tripRequestId: request.id,
            isPrivate: true,
            departureLocation: 'A',
            arrivalLocation: 'B',
            departureDate: request.departureDateMin,
            totalSeats: 4,
            availableSeats: 3,
            pricePerSeat: 5000,
            status: TripStatus.PENDING,
          })
        : null;
      const booking = trip
        ? await db.getRepository(Booking).save({
            tripId: trip.id,
            passengerId: passenger.id,
            numberOfSeats: 1,
            status: BookingStatus.ACCEPTED,
            paymentMode: TripPaymentMode.ELECTRONIC,
            paymentStatus: BookingPaymentStatus.PENDING,
            paymentAmount: 5000,
            grossPaymentAmount: 5000,
            paymentCurrency: 'CDF',
          })
        : null;
      if (trip) {
        request.tripId = trip.id;
        await db.getRepository(TripRequest).save(request);
      }
      const dto = {
        selectedDriverId: driver.id,
        selectedAt: request.selectedAt!.toISOString(),
      };
      const run = () =>
        changeRequestDriver(
          db.manager,
          passenger.id,
          request.id,
          dto,
          bookings,
        );
      return {
        passenger,
        driver,
        request,
        offer,
        trip: trip!,
        booking: booking!,
        dto,
        run,
      };
    }
    async function notices(requestId: string) {
      return db
        .getRepository(Notification)
        .createQueryBuilder('n')
        .where("n.data->>'tripRequestId' = :id", { id: requestId })
        .getMany();
    }

    it('reopens the same planned request before the deadline, clears targeting and excludes only the released driver', async () => {
      const f = await fixture(false);
      await expect(f.run()).resolves.toEqual({
        changed: true,
        bookingIds: [],
        tripId: null,
      });
      expect(
        await db
          .getRepository(TripRequest)
          .findOneByOrFail({ id: f.request.id }),
      ).toMatchObject({
        status: TripRequestStatus.PENDING,
        selectedDriverId: null,
        selectedAt: null,
        tripId: null,
        targetDriverId: null,
        departureDateMin: f.request.departureDateMin,
        departureDateMax: f.request.departureDateMax,
        paymentMode: f.request.paymentMode,
        maxPricePerSeat: '5000.00',
        numberOfSeats: 1,
      });
      expect(
        await hasRefusedRequest(db.manager, f.driver.id, f.request.id),
      ).toBe(true);
      expect(
        await hasRefusedRequest(db.manager, f.passenger.id, f.request.id),
      ).toBe(false);
      const [exclusion] = await db.query(
        'SELECT reason FROM trip_request_driver_refusals WHERE "requestId"=$1',
        [f.request.id],
      );
      expect(exclusion.reason).toBe('passenger_changed_driver');
      expect((await notices(f.request.id)).map((n) => n.userId).sort()).toEqual(
        [f.passenger.id, f.driver.id].sort(),
      );
      expect(
        await db.getRepository(DriverOffer).findOneByOrFail({ id: f.offer.id }),
      ).toMatchObject({ status: DriverOfferStatus.CANCELLED });
    });

    it.each([TripStatus.PENDING, TripStatus.ACTIVE])(
      'cancels an unpaid private booking and closes its empty trip before pickup (%s)',
      async (status) => {
        const f = await fixture();
        await db.getRepository(Trip).update(f.trip.id, { status });
        await f.run();
        expect(
          await db.getRepository(Booking).findOneByOrFail({ id: f.booking.id }),
        ).toMatchObject({
          status: BookingStatus.CANCELLED,
          cancelledAt: expect.any(Date),
        });
        expect(
          await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }),
        ).toMatchObject({
          status: TripStatus.CANCELLED,
          availableSeats: 4,
          tripRequestId: null,
        });
        expect(
          await db.transaction(async (manager) =>
            recoverRequestAcceptance(
              manager,
              await db
                .getRepository(TripRequest)
                .findOneByOrFail({ id: f.request.id }),
            ),
          ),
        ).toBeNull();
      },
    );

    it('preserves other passengers on an ongoing shared trip and releases only this seat', async () => {
      const f = await fixture();
      const other = await db
        .getRepository(User)
        .save({ firstName: 'Other', lastName: 'Passenger' });
      const reservation = await db.getRepository(Booking).save({
        tripId: f.trip.id,
        passengerId: other.id,
        numberOfSeats: 2,
        status: BookingStatus.ACCEPTED,
        pickedUp: true,
      });
      await db
        .getRepository(Trip)
        .update(f.trip.id, { status: TripStatus.ACTIVE, availableSeats: 1 });
      await f.run();
      expect(
        await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }),
      ).toMatchObject({
        status: TripStatus.ACTIVE,
        availableSeats: 2,
        tripRequestId: null,
      });
      expect(
        await db.getRepository(Booking).findOneByOrFail({ id: reservation.id }),
      ).toMatchObject({ status: BookingStatus.ACCEPTED, pickedUp: true });
    });

    it('preserves an unrelated shared trip and rejects the released driver even in legacy broadcast mode', async () => {
      const f = await fixture();
      await db.getRepository(Trip).update(f.trip.id, {
        tripRequestId: null,
        isPrivate: false,
        status: TripStatus.ACTIVE,
      });
      await f.run();
      expect(
        await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }),
      ).toMatchObject({
        status: TripStatus.ACTIVE,
        isPrivate: false,
        availableSeats: 4,
      });
      const shared = new SharedTripOffersService(db, bookings);
      await expect(
        shared.propose(f.driver.id, f.request.id, f.trip.id),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('renews an elapsed pickup window for 30 minutes', async () => {
      const f = await fixture(false);
      await db.getRepository(TripRequest).update(f.request.id, {
        departureDateMax: new Date(Date.now() - 60000),
      });
      await f.run();
      const r = await db
        .getRepository(TripRequest)
        .findOneByOrFail({ id: f.request.id });
      expect(r.departureDateMax.getTime() - r.departureDateMin.getTime()).toBe(
        1800000,
      );
      expect(r.departureDateMax.getTime()).toBeGreaterThan(
        Date.now() + 1700000,
      );
    });

    it.each([
      { pickedUp: true },
      { pickedUpConfirmedByPassenger: true },
      { pickedUpAt: new Date() },
      {
        rideDeclarations: {
          pickup: {
            driver: {
              eventId: randomUUID(),
              decision: 'confirm',
              occurredAt: new Date().toISOString(),
              receivedAt: new Date().toISOString(),
            },
          },
        },
      },
      { rideEffectsPending: ['pickup'] },
      { status: BookingStatus.COMPLETED },
    ] as Partial<Booking>[])(
      'blocks boarding or a pending ride declaration: %j',
      async (patch) => {
        const f = await fixture();
        await db.getRepository(Booking).update(f.booking.id, patch);
        await expect(f.run()).rejects.toMatchObject({
          response: { code: 'REQUEST_DRIVER_CHANGE_PICKUP_STARTED' },
        });
        expect(
          (
            await db
              .getRepository(TripRequest)
              .findOneByOrFail({ id: f.request.id })
          ).selectedDriverId,
        ).toBe(f.driver.id);
        expect(await notices(f.request.id)).toHaveLength(0);
      },
    );

    it.each([
      { paidAt: new Date() },
      { paymentStatus: BookingPaymentStatus.INITIATED },
      { paymentStatus: BookingPaymentStatus.SUCCEEDED },
      { mixedTokenQuantity: 10 },
    ] as Partial<Booking>[])(
      'blocks committed or initiated payment: %j',
      async (patch) => {
        const f = await fixture();
        await db.getRepository(Booking).update(f.booking.id, patch);
        await expect(f.run()).rejects.toMatchObject({
          response: { code: 'REQUEST_DRIVER_CHANGE_PAYMENT_ENGAGED' },
        });
        expect(
          (
            await db
              .getRepository(Booking)
              .findOneByOrFail({ id: f.booking.id })
          ).status,
        ).toBe(BookingStatus.ACCEPTED);
      },
    );

    it.each([
      PaymentStatus.PENDING,
      PaymentStatus.FAILED,
      PaymentStatus.SUCCEEDED,
    ])(
      'blocks a provider attempt even if booking payment fields are stale (%s)',
      async (status) => {
        const f = await fixture();
        await db.getRepository(PaymentTransaction).save({
          userId: f.passenger.id,
          purpose: PaymentPurpose.TRIP_BOOKING,
          relatedEntityType: 'booking',
          relatedEntityId: f.booking.id,
          method: PaymentMethod.MOBILE_MONEY,
          reference: randomUUID(),
          status,
          amount: 5000,
          currency: 'CDF',
        });
        await expect(f.run()).rejects.toMatchObject({
          response: { code: 'REQUEST_DRIVER_CHANGE_PAYMENT_ENGAGED' },
        });
      },
    );

    it('does not authorize other passengers or stale selection snapshots', async () => {
      const f = await fixture(false);
      await expect(
        changeRequestDriver(
          db.manager,
          f.driver.id,
          f.request.id,
          f.dto,
          bookings,
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        changeRequestDriver(
          db.manager,
          f.passenger.id,
          f.request.id,
          { ...f.dto, selectedAt: new Date(0).toISOString() },
          bookings,
        ),
      ).rejects.toMatchObject({
        response: { code: 'REQUEST_DRIVER_SELECTION_CHANGED' },
      });
    });

    it('is idempotent concurrently and never cancels a later driver on retry', async () => {
      const f = await fixture();
      const results = await Promise.all([f.run(), f.run()]);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect(await notices(f.request.id)).toHaveLength(2);
      const next = await db
        .getRepository(User)
        .save({ firstName: 'Next', lastName: 'Driver' });
      await db.getRepository(TripRequest).update(f.request.id, {
        status: TripRequestStatus.DRIVER_SELECTED,
        selectedDriverId: next.id,
        selectedAt: new Date(),
      });
      expect((await f.run()).changed).toBe(false);
      expect(
        (
          await db
            .getRepository(TripRequest)
            .findOneByOrFail({ id: f.request.id })
        ).selectedDriverId,
      ).toBe(next.id);
    });

    it('rolls back cancellation and exclusion when durable notification insertion fails', async () => {
      const f = await fixture();
      jest
        .spyOn(outbox, 'enqueueTransactionalNotification')
        .mockRejectedValueOnce(new Error('outbox unavailable'));
      await expect(f.run()).rejects.toThrow('outbox unavailable');
      expect(
        (await db.getRepository(Booking).findOneByOrFail({ id: f.booking.id }))
          .status,
      ).toBe(BookingStatus.ACCEPTED);
      expect(
        (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }))
          .tripRequestId,
      ).toBe(f.request.id);
      expect(
        await hasRefusedRequest(db.manager, f.driver.id, f.request.id),
      ).toBe(false);
    });

    it('serializes payment initiation against reassignment: only one can win', async () => {
      const f = await fixture();
      const repo = db.getRepository(PaymentTransaction);
      const candidate = repo.create({
        userId: f.passenger.id,
        purpose: PaymentPurpose.TRIP_BOOKING,
        relatedEntityType: 'booking',
        relatedEntityId: f.booking.id,
        method: PaymentMethod.MOBILE_MONEY,
        reference: randomUUID(),
        amount: 5000,
        currency: 'CDF',
      });
      const results = await Promise.allSettled([
        f.run(),
        claimBookingPayment(repo, candidate),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const r = await db
        .getRepository(TripRequest)
        .findOneByOrFail({ id: f.request.id });
      const payments = await repo.countBy({ relatedEntityId: f.booking.id });
      expect(
        r.status === TripRequestStatus.PENDING
          ? payments === 0
          : payments === 1,
      ).toBe(true);
    });

    it('rejects a slow legacy start after the passenger changes driver', async () => {
      const f = await fixture(false);
      await f.run();
      const trip = db.getRepository(Trip).create({
        driverId: f.driver.id,
        tripRequestId: f.request.id,
        isPrivate: true,
        departureLocation: 'A',
        arrivalLocation: 'B',
        departureDate: f.request.departureDateMin,
        totalSeats: 4,
        availableSeats: 4,
        pricePerSeat: 5000,
      });
      await expect(
        saveRequestTrip(db.getRepository(Trip), trip, f.request),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db.getRepository(Trip).countBy({ tripRequestId: f.request.id }),
      ).toBe(0);
    });

    it('cancels a prepared legacy trip before its booking links it to the request', async () => {
      const f = await fixture(false);
      const trip = await saveRequestTrip(
        db.getRepository(Trip),
        db.getRepository(Trip).create({
          driverId: f.driver.id,
          tripRequestId: f.request.id,
          isPrivate: true,
          departureLocation: 'A',
          arrivalLocation: 'B',
          departureDate: f.request.departureDateMin,
          totalSeats: 4,
          availableSeats: 4,
          pricePerSeat: 5000,
        }),
        f.request,
      );
      await f.run();
      expect(
        await db.getRepository(Trip).findOneByOrFail({ id: trip.id }),
      ).toMatchObject({ status: TripStatus.CANCELLED, tripRequestId: null });
    });

    it('returns a retryable conflict instead of deadlocking a trip-first boarding action', async () => {
      const f = await fixture();
      await db.transaction(async (manager) => {
        await manager.findOne(Trip, {
          where: { id: f.trip.id },
          lock: { mode: 'pessimistic_write' },
        });
        await expect(f.run()).rejects.toMatchObject({
          response: { code: 'REQUEST_DRIVER_CHANGE_BUSY' },
        });
        // The booking lock was released by the failed transaction.
        await manager.findOne(Booking, {
          where: { id: f.booking.id },
          lock: { mode: 'pessimistic_write', onLocked: 'nowait' },
        });
        await manager.update(Booking, f.booking.id, { pickedUp: true });
      });
      await expect(f.run()).rejects.toMatchObject({
        response: { code: 'REQUEST_DRIVER_CHANGE_PICKUP_STARTED' },
      });
    });

    it('releases a first-trip subsidy reservation without charging or refunding money', async () => {
      const f = await fixture();
      await db.getRepository(Booking).update(f.booking.id, {
        firstTripSubsidyApplied: true,
        passengerPaymentRate: 0.5,
        zwangaSubsidyAmount: 2500,
        paymentAmount: 2500,
      });
      await f.run();
      expect(
        await db.getRepository(Booking).findOneByOrFail({ id: f.booking.id }),
      ).toMatchObject({
        firstTripSubsidyApplied: false,
        passengerPaymentRate: null,
        zwangaSubsidyAmount: '0.00',
        paymentAmount: '5000.00',
      });
      expect(
        await db
          .getRepository(PaymentTransaction)
          .countBy({ relatedEntityId: f.booking.id }),
      ).toBe(0);
    });

    it('retires obsolete booking/offer confirmations without touching unrelated notifications', async () => {
      const f = await fixture();
      for (const type of [
        'trip_request_accepted',
        'offer_accepted',
        'new_booking',
        'booking_response',
      ]) {
        await outbox.enqueueTransactionalNotification(db.manager, {
          eventKey: randomUUID(),
          userId: f.driver.id,
          title: 'Old',
          body: 'Old',
          data: { type, tripRequestId: f.request.id, bookingId: f.booking.id },
        });
      }
      await outbox.enqueueTransactionalNotification(db.manager, {
        eventKey: randomUUID(),
        userId: f.driver.id,
        title: 'Unrelated',
        body: 'Unrelated',
        data: { type: 'new_booking', bookingId: randomUUID() },
      });
      await f.run();
      const messages = await notices(f.request.id);
      expect(
        messages.filter((n) => n.title === 'Old').every((n) => !n.isActive),
      ).toBe(true);
      expect(messages.filter((n) => n.isActive)).toHaveLength(2);
      expect(
        (
          await db
            .getRepository(Notification)
            .findOneByOrFail({ title: 'Unrelated', userId: f.driver.id })
        ).isActive,
      ).toBe(true);
    });

    it('migration rollback keeps exclusions, and reapplying is supported', async () => {
      const f = await fixture(false);
      await f.run();
      await db.transaction(async (manager) => {
        const migration = new PassengerDriverChangeReason1780000102000();
        await migration.down(manager.queryRunner!);
        expect(
          await hasRefusedRequest(manager, f.driver.id, f.request.id),
        ).toBe(true);
        await migration.up(manager.queryRunner!);
      });
    });
  },
);
