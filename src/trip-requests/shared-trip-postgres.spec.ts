import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { typeOrmEntities } from '../database/entities';
import { AddDriverDispatch1780000048000 } from '../database/migrations/1780000048000-AddDriverDispatch';
import { BroadcastDriverRequests1780000074000 } from '../database/migrations/1780000074000-BroadcastDriverRequests';
import { RetainDriverLastLocation1780000076000 } from '../database/migrations/1780000076000-RetainDriverLastLocation';
import { NearbyRequestRingingCooldown1780000087000 } from '../database/migrations/1780000087000-NearbyRequestRingingCooldown';
import { DispatchDeliveryResilience1780000088000 } from '../database/migrations/1780000088000-DispatchDeliveryResilience';
import { RememberDriverRequestRefusals1780000095000 } from '../database/migrations/1780000095000-RememberDriverRequestRefusals';
import { SharedTripOffers1780000079000 } from '../database/migrations/1780000079000-SharedTripOffers';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { Vehicle, VehicleType } from '../vehicles/entities/vehicle.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { Notification } from '../notifications/entities/notification.entity';
import { RideAlertChanges } from '../notifications/ride-alert-changes';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { SharedTripOffersService } from './shared-trip-offers.service';
import { enqueueSharedTripAlert, sharedTripAlertIsDeliverable } from './dispatch/shared-trip-alert';
import { finishEmptyPrivateTrip } from '../bookings/private-trip-cancellation';
import { TripRequestsService } from './trip-requests.service';

const bin = process.env.DISPATCH_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'shared offers on isolated PostgreSQL/PostGIS',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource,
      bookings: BookingsService,
      offers: SharedTripOffersService;
    const point = { type: 'Point' as const, coordinates: [15.31, -4.3] };
    beforeAll(async () => {
      db = await cluster.start();
      db.setOptions({ entities: typeOrmEntities });
      await (db as any).buildMetadatas();
      await db.query(
        'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
      );
      await db.synchronize();
      const runner = db.createQueryRunner();
      try {
        await db.query(
          'ALTER TABLE trip_requests DROP COLUMN "immediateDispatch"',
        );
        await new AddDriverDispatch1780000048000().up(runner);
        await new BroadcastDriverRequests1780000074000().up(runner);
        await new RetainDriverLastLocation1780000076000().up(runner);
        await new NearbyRequestRingingCooldown1780000087000().up(runner);
        await new DispatchDeliveryResilience1780000088000().up(runner);
        // This SQL-only table is not created by TypeORM entity synchronization.
        await new RememberDriverRequestRefusals1780000095000().up(runner);
        await db.query(
          'ALTER TABLE driver_offers DROP COLUMN "existingTripId", DROP COLUMN "sharedBookingId", DROP COLUMN "sharedTripConsentAt"',
        );
        const migration = new SharedTripOffers1780000079000();
        await migration.up(runner);
        await migration.down(runner);
        await migration.up(runner);
      } finally {
        await runner.release();
      }
      bookings = Object.assign(Object.create(BookingsService.prototype), {
        bookingRepository: db.getRepository(Booking),
        tripRepository: db.getRepository(Trip),
        userRepository: db.getRepository(User),
        dataSource: db,
        configService: new ConfigService({
          FIRST_TRIP_SUBSIDY_ENABLED: 'false',
          TRIP_PAYMENT_CURRENCY: 'CDF',
        }),
        MAX_SEATS_WITHOUT_APPROVED_KYC: 2,
        logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        cacheService: { del: jest.fn().mockResolvedValue(undefined) },
        walletService: { convertPointsToMoney: () => 25 },
      });
      offers = new SharedTripOffersService(db, bookings);
    });
    afterAll(() => cluster.stop());
    beforeEach(() => db.query('TRUNCATE users CASCADE'));
    const user = () =>
      db.getRepository(User).save({ firstName: 'Test', lastName: 'Test' });
    async function fixture(immediateDispatch = false) {
      const driver = await db
        .getRepository(User)
        .save({
          firstName: 'Test',
          lastName: 'Driver',
          role: UserRole.DRIVER,
          status: UserStatus.ACTIVE,
          isActive: true,
          fcmToken: 'synthetic-token',
        });
      await db
        .getRepository(KycDocument)
        .save({ userId: driver.id, status: KycStatus.APPROVED });
      const vehicle = await db
        .getRepository(Vehicle)
        .save({
          ownerId: driver.id,
          type: VehicleType.CAR,
          isActive: true,
          brand: 'Test',
          model: 'Test',
          licensePlate: randomUUID(),
          color: 'Test',
        });
      const passenger = await user();
      const trip = await db
        .getRepository(Trip)
        .save({
          driverId: driver.id,
          vehicleId: vehicle.id,
          departureLocation: 'A',
          arrivalLocation: 'B',
          departurePoint: point,
          arrivalPoint: point,
          departureDate: new Date(),
          status: TripStatus.ACTIVE,
          startedAt: new Date(),
          totalSeats: 2,
          availableSeats: 1,
          pricePerSeat: 1000,
          isPrivate: true,
          currentLocation: point,
        });
      const originalPassenger = await user();
      const originalBooking = await db
        .getRepository(Booking)
        .save({
          passengerId: originalPassenger.id,
          tripId: trip.id,
          numberOfSeats: 1,
          status: BookingStatus.ACCEPTED,
        });
      const request = await makeRequest(passenger.id, immediateDispatch);
      return { driver, vehicle, passenger, trip, request, originalBooking };
    }
    function makeRequest(passengerId: string, immediateDispatch = false) {
      return db
        .getRepository(TripRequest)
        .save({
          passengerId,
          immediateDispatch,
          departureLocation: 'A',
          arrivalLocation: 'B',
          departurePoint: point,
          arrivalPoint: point,
          departureDateMin: new Date(),
          departureDateMax: new Date(Date.now() + 600_000),
          numberOfSeats: 1,
          maxPricePerSeat: 1500,
          vehicleType: VehicleType.CAR,
          paymentMode: TripPaymentMode.CASH,
        });
    }
    async function propose(f: Awaited<ReturnType<typeof fixture>>) {
      return offers.propose(f.driver.id, f.request.id, f.trip.id);
    }
    it('publishes the committed shared acceptance to both parties', async () => {
      const f = await fixture(true), offer = await propose(f);
      const publish = jest.fn(), changes = new RideAlertChanges(db, { publish } as any);
      try {
        await offers.accept(f.passenger.id, f.request.id, offer.offerId, true);
        for (let attempt = 0; attempt < 100 && !publish.mock.calls.some(call => call[1].requestId === f.request.id); attempt++)
          await new Promise(resolve => setTimeout(resolve, 20));
        expect(publish).toHaveBeenCalledWith(f.driver.id, { kind: 'changed', requestId: f.request.id, terminal: true });
        expect(publish).toHaveBeenCalledWith(f.passenger.id, { kind: 'changed', requestId: f.request.id, terminal: true });
      } finally { changes.onModuleDestroy(); }
    });
    it('notifies an ongoing driver from the active-trip position even without discovery GPS; never assigns', async () => {
      const f = await fixture(true);
      // Wait for both transactions even on failure before the next TRUNCATE.
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          db.transaction((m) => enqueueSharedTripAlert(m, f.request.id)),
        ),
      );
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
      const notifications = await db.getRepository(Notification).find();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].data).toMatchObject({
        sharedTrip: true,
        existingTripId: f.trip.id,
        passengerId: f.passenger.id,
      });
      expect(
        (
          await db
            .getRepository(TripRequest)
            .findOneByOrFail({ id: f.request.id })
        ).selectedDriverId,
      ).toBeNull();
      expect(await db.getRepository(Booking).count()).toBe(1);
    });
    it.each(['full', 'wrong-vehicle', 'far', 'offline', 'revoked-kyc', 'refused', 'targeted-to-another'])(
      'does not notify a %s driver',
      async (reason) => {
        const f = await fixture();
        if (reason === 'full')
          await db.getRepository(Trip).update(f.trip.id, { availableSeats: 0 });
        if (reason === 'wrong-vehicle')
          await db
            .getRepository(Vehicle)
            .update(f.vehicle.id, { type: VehicleType.MOTORCYCLE_TWO_WHEELS });
        if (reason === 'far')
          await db
            .getRepository(Trip)
            .update(f.trip.id, {
              currentLocation: { type: 'Point', coordinates: [16, -4.3] },
            });
        if (reason === 'revoked-kyc')
          await db
            .getRepository(KycDocument)
            .update({ userId: f.driver.id }, { status: KycStatus.REJECTED });
        if (reason === 'offline')
          await db.query(
            `INSERT INTO driver_dispatch_presence
      ("driverId","vehicleId",seats,position,"expiresAt","leaseId","discoveryEnabled")
      VALUES ($1,$2,2,ST_SetSRID(ST_MakePoint(15.31,-4.3),4326),now(),$3,false)`,
            [f.driver.id, f.vehicle.id, randomUUID()],
          );
        if (reason === 'refused')
          await db.query(
            'INSERT INTO trip_request_driver_refusals ("driverId", "requestId") VALUES ($1, $2)',
            [f.driver.id, f.request.id],
          );
        if (reason === 'targeted-to-another')
          await db.getRepository(TripRequest).update(f.request.id, {
            targetDriverId: (await user()).id,
          });
        expect(
          await db.transaction((m) => enqueueSharedTripAlert(m, f.request.id)),
        ).toBe(false);
        expect(await db.getRepository(Notification).count()).toBe(0);
      },
    );
    it('keeps immediate dispatch open while waiting for consent and allows refusal without consuming seats', async () => {
      const f = await fixture(true),
        offer = await propose(f);
      expect(
        (
          await db
            .getRepository(TripRequest)
            .findOneByOrFail({ id: f.request.id })
        ).status,
      ).toBe(TripRequestStatus.PENDING);
      await expect(
        offers.accept(f.passenger.id, f.request.id, offer.offerId, false),
      ).rejects.toThrow();
      await offers.decline(f.passenger.id, f.request.id, offer.offerId);
      expect(
        (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }))
          .availableSeats,
      ).toBe(1);
      expect(await db.getRepository(Booking).count()).toBe(1);
    });
    it('atomically records consent, one booking at the displayed fare, seats and both notifications; retries are idempotent', async () => {
      const f = await fixture(),
        offer = await propose(f);
      const result = await offers.accept(
        f.passenger.id,
        f.request.id,
        offer.offerId,
        true,
      );
      expect(
        await offers.accept(f.passenger.id, f.request.id, offer.offerId, true),
      ).toEqual(result);
      const booking = await db
        .getRepository(Booking)
        .findOneByOrFail({ id: result.bookingId });
      expect(booking).toMatchObject({
        status: BookingStatus.ACCEPTED,
        tripId: f.trip.id,
        numberOfSeats: 1,
      });
      expect(Number(booking.paymentAmount)).toBe(1000);
      expect(
        (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }))
          .availableSeats,
      ).toBe(0);
      expect(
        (
          await db
            .getRepository(DriverOffer)
            .findOneByOrFail({ id: offer.offerId })
        ).sharedTripConsentAt,
      ).toBeInstanceOf(Date);
      expect(await db.getRepository(Trip).count()).toBe(1);
      expect(await db.getRepository(Booking).count()).toBe(2);
      expect(await db.getRepository(Notification).count()).toBe(3);
      const runner = db.createQueryRunner();
      try {
        await expect(
          new SharedTripOffers1780000079000().down(runner),
        ).rejects.toThrow('consents exist');
      } finally {
        await runner.release();
      }
    });
    it('arbitrates the last seat between two passengers without overbooking or partial assignment', async () => {
      const f = await fixture(),
        second = await user();
      const request2 = await makeRequest(second.id);
      const a = await propose(f),
        b = await offers.propose(f.driver.id, request2.id, f.trip.id);
      const results = await Promise.allSettled([
        offers.accept(f.passenger.id, f.request.id, a.offerId, true),
        offers.accept(second.id, request2.id, b.offerId, true),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.getRepository(Booking).count()).toBe(2);
      expect(
        await db
          .getRepository(TripRequest)
          .countBy({ status: TripRequestStatus.DRIVER_SELECTED }),
      ).toBe(1);
      expect(
        (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }))
          .availableSeats,
      ).toBe(0);
    });
    it('returns the same booking for simultaneous acceptance retries', async () => {
      const f = await fixture(),
        offer = await propose(f);
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          offers.accept(f.passenger.id, f.request.id, offer.offerId, true),
        ),
      );
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
      expect(results[0]).toEqual(results[1]);
      expect(await db.getRepository(Booking).count()).toBe(2);
    });
    it('does not close a private trip when either passenger cancels while another remains', async () => {
      const f = await fixture(),
        offer = await propose(f);
      const result = await offers.accept(
        f.passenger.id,
        f.request.id,
        offer.offerId,
        true,
      );
      const newBooking = await db
        .getRepository(Booking)
        .findOneByOrFail({ id: result.bookingId });
      await db
        .getRepository(Booking)
        .update(newBooking.id, { status: BookingStatus.CANCELLED });
      expect(
        await finishEmptyPrivateTrip(
          db.getRepository(Trip),
          f.trip.id,
          newBooking,
        ),
      ).toBeNull();
      expect(
        (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }))
          .status,
      ).toBe(TripStatus.ACTIVE);
      await db
        .getRepository(Booking)
        .update(f.originalBooking.id, { status: BookingStatus.CANCELLED });
      expect(
        (
          await finishEmptyPrivateTrip(
            db.getRepository(Trip),
            f.trip.id,
            f.originalBooking,
          )
        )?.status,
      ).toBe(TripStatus.CANCELLED);
    });
    it('records no consent if an independent driver is selected before the shared offer is accepted', async () => {
      const f = await fixture(true),
        offer = await propose(f);
      await db
        .getRepository(TripRequest)
        .update(f.request.id, {
          selectedDriverId: f.driver.id,
          status: TripRequestStatus.DRIVER_SELECTED,
        });
      await expect(
        offers.accept(f.passenger.id, f.request.id, offer.offerId, true),
      ).rejects.toThrow();
      expect(await db.getRepository(Booking).count()).toBe(1);
      expect(
        (
          await db
            .getRepository(DriverOffer)
            .findOneByOrFail({ id: offer.offerId })
        ).sharedTripConsentAt,
      ).toBeNull();
    });
    it.each([
      'price',
      'finished',
      'cancelled-request',
      'vehicle',
      'kyc',
      'stolen',
    ])(
      'rejects acceptance after %s changes without booking',
      async (reason) => {
        const f = await fixture(),
          offer = await propose(f);
        if (reason === 'price')
          await db
            .getRepository(Trip)
            .update(f.trip.id, { pricePerSeat: 1200 });
        if (reason === 'finished')
          await db
            .getRepository(Trip)
            .update(f.trip.id, { status: TripStatus.COMPLETED });
        if (reason === 'cancelled-request')
          await db
            .getRepository(TripRequest)
            .update(f.request.id, { status: TripRequestStatus.CANCELLED });
        if (reason === 'vehicle')
          await db
            .getRepository(Vehicle)
            .update(f.vehicle.id, { isActive: false });
        if (reason === 'kyc')
          await db
            .getRepository(Trip)
            .update(f.trip.id, { requiresPassengerKyc: true });
        await expect(
          offers.accept(
            reason === 'stolen' ? f.driver.id : f.passenger.id,
            f.request.id,
            offer.offerId,
            true,
          ),
        ).rejects.toThrow();
        expect(await db.getRepository(Booking).count()).toBe(1);
        expect(
          (
            await db
              .getRepository(DriverOffer)
              .findOneByOrFail({ id: offer.offerId })
          ).status,
        ).toBe(DriverOfferStatus.PENDING);
      },
    );
    it('rolls back booking and seats if recording the consent/outbox fails', async () => {
      const f = await fixture(),
        offer = await propose(f);
      const original = bookings.create.bind(bookings);
      const fail = jest
        .spyOn(bookings, 'create')
        .mockImplementation((passengerId, dto, selection) =>
          original(passengerId, dto, {
            ...selection!,
            selected: async () => {
              throw new Error('simulated transaction failure');
            },
          }),
        );
      try {
        await expect(
          offers.accept(f.passenger.id, f.request.id, offer.offerId, true),
        ).rejects.toThrow('simulated');
      } finally {
        fail.mockRestore();
      }
      expect(await db.getRepository(Booking).count()).toBe(1);
      expect(
        (await db.getRepository(Trip).findOneByOrFail({ id: f.trip.id }))
          .availableSeats,
      ).toBe(1);
    });
  it('suppresses a queued shared alert if the ongoing trip fills up or finishes', async () => {
    const f = await fixture();
    expect(await sharedTripAlertIsDeliverable(db.manager, f.driver.id, f.request.id, f.trip.id)).toBe(true);
    await db.getRepository(Trip).update(f.trip.id, { availableSeats: 0 });
    expect(await sharedTripAlertIsDeliverable(db.manager, f.driver.id, f.request.id, f.trip.id)).toBe(false);
    await db.getRepository(Trip).update(f.trip.id, { availableSeats: 1, status: TripStatus.COMPLETED });
    expect(await sharedTripAlertIsDeliverable(db.manager, f.driver.id, f.request.id, f.trip.id)).toBe(false);
  });
  it('serializes cancelling an unassigned request against consent without orphaning an accepted booking', async () => {
    const f = await fixture(), offer = await propose(f);
    const requests: TripRequestsService = Object.assign(Object.create(TripRequestsService.prototype), {
      logger: { log: jest.fn() },
      tripRequestRepository: { manager: db.manager, findOne: jest.fn().mockResolvedValue(f.request) },
    });
    await Promise.allSettled([
      offers.accept(f.passenger.id, f.request.id, offer.offerId, true),
      requests.cancel(f.passenger.id, f.request.id),
    ]);
    const saved = await db.getRepository(TripRequest).findOneByOrFail({ id: f.request.id });
    const total = await db.getRepository(Booking).count();
    if (saved.status === TripRequestStatus.CANCELLED) {
      expect(saved.tripId).toBeNull();
      expect(total).toBe(1);
    } else {
      expect(saved.status).toBe(TripRequestStatus.DRIVER_SELECTED);
      expect(saved.tripId).toBe(f.trip.id);
      expect(total).toBe(2);
    }
  });
  },
);
