import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { TripRequestsService } from '../src/trip-requests/trip-requests.service';
import { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { DriverOffer } from '../src/trip-requests/entities/driver-offer.entity';
import { User } from '../src/users/entities/user.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { Trip } from '../src/trips/entities/trip.entity';
import type { TripsService } from '../src/trips/trips.service';
import { Booking } from '../src/bookings/entities/booking.entity';
import { BookingsService } from '../src/bookings/bookings.service';
import { saveRequestTrip } from '../src/trips/save-request-trip';
import { claimRequestAcceptance } from '../src/trip-requests/dispatch/request-acceptance';
import { declineRequestForDriver } from '../src/trip-requests/request-refusal';
import { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import { SequentialDispatchService } from '../src/trip-requests/dispatch/sequential-dispatch.service';
import { SeparateRequestAttentionLease1780000101000 } from '../src/database/migrations/1780000101000-SeparateRequestAttentionLease';

type Context = {
  db: DataSource;
  relay: SequentialDispatchService;
  dispatch: DriverDispatchService;
  driver: (longitude?: number) => Promise<User>;
  request: (
    immediate?: boolean,
    target?: string | null,
  ) => Promise<TripRequest>;
  offers: (
    id: string,
  ) => Promise<
    { id: string; status: string; driverId: string; expiresAt: Date }[]
  >;
};

/** Real queries, locks, booking and selection. Only external route/media/subscription providers are stubbed. */
function serviceFor({ db, dispatch }: Context) {
  const bookings = Object.assign(
    Object.create(BookingsService.prototype) as BookingsService,
    {
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
      walletService: { convertPointsToMoney: () => 10 },
    },
  );
  const trips = {
    create: async (
      driverId: string,
      dto: Parameters<TripsService['create']>[1],
      options: NonNullable<Parameters<TripsService['create']>[2]>,
    ) =>
      saveRequestTrip(
        db.getRepository(Trip),
        db.getRepository(Trip).create({
          driverId,
          vehicleId: dto.vehicleId,
          tripRequestId: options.tripRequestId,
          isPrivate: true,
          departureLocation: dto.departureLocation,
          arrivalLocation: dto.arrivalLocation,
          departureDate: new Date(dto.departureDate),
          totalSeats: dto.totalSeats,
          availableSeats: dto.totalSeats,
          pricePerSeat: dto.pricePerSeat,
          requiresPassengerKyc: dto.requiresPassengerKyc,
        }),
        options.requestSnapshot!,
        options.acceptanceToken,
      ),
    cancelFailedRequestTrip: jest.fn(),
  };
  return new TripRequestsService(
    db.getRepository(TripRequest),
    db.getRepository(DriverOffer),
    db.getRepository(User),
    db.getRepository(Vehicle),
    {} as never,
    {} as never,
    trips as never,
    bookings,
    {} as never,
    {
      getPremiumOverview: () =>
        Promise.resolve({
          isPremium: false,
          premiumBadgeEnabled: false,
        }),
    } as never,
    {} as never,
    {} as never,
    dispatch,
  );
}

export function availableRequestFlow(context: () => Context) {
  it('attention leases and preparation leases stay separate; unsafe rollback does not discard either', async () => {
    const c = context(),
      first = await c.driver(),
      r = await c.request(),
      other = await c.request(false, first.id);
    await c.relay.advance(other.id);
    const alert = (await c.offers(other.id))[0];
    const vehicle = await c.db
      .getRepository(Vehicle)
      .findOneByOrFail({ ownerId: first.id });
    await claimRequestAcceptance(c.db.manager, r, first.id, {
      vehicleId: vehicle.id,
      seats: 1,
    });
    const claim = (await c.offers(r.id))[0];
    expect(claim.expiresAt.getTime() - Date.now()).toBeGreaterThan(100000);
    expect((await c.dispatch.status(first.id)).pendingOfferId).toBe(alert.id);
    expect((await c.dispatch.getOffer(first.id, claim.id)).actionable).toBe(
      false,
    );
    const runner = c.db.createQueryRunner();
    try {
      await expect(
        new SeparateRequestAttentionLease1780000101000().down(runner),
      ).rejects.toThrow();
      expect((await c.offers(r.id))[0].status).toBe('pending');
      expect((await c.offers(other.id))[0].status).toBe('pending');
      await c.db.query(
        `UPDATE trip_request_dispatch_offers SET status='cancelled' WHERE "requestId"=$1`,
        [other.id],
      );
      await new SeparateRequestAttentionLease1780000101000().down(runner);
      await new SeparateRequestAttentionLease1780000101000().up(runner);
      expect((await c.dispatch.status(first.id)).pendingOfferId).toBeNull();
    } finally {
      await runner.release();
    }
  });
  it.each([false, true])(
    'available list/detail/accept works without an alert (immediate=%s)',
    async (immediate) => {
      const c = context(),
        driver = await c.driver(),
        other = await c.driver(15.311),
        r = await c.request(immediate);
      const service = serviceFor(c);
      expect((await service.findAll(driver.id)).map((row) => row.id)).toContain(
        r.id,
      );
      expect(
        (await service.findRequestPage(driver.id, false, {})).data.map(
          (row) => row.id,
        ),
      ).toContain(r.id);
      expect(
        (await service.findOne(r.id, driver.id)).responseWindow,
      ).toBeUndefined();
      expect(await c.offers(r.id)).toHaveLength(0);
      const vehicle = await c.db
        .getRepository(Vehicle)
        .findOneByOrFail({ ownerId: driver.id });
      const result = await service.acceptTripRequest(driver.id, r.id, {
        vehicleId: vehicle.id,
      });
      expect(result.tripRequest.selectedDriver?.id).toBe(driver.id);
      expect(await c.db.getRepository(Booking).count()).toBe(1);
      expect(
        (
          await c.db
            .getRepository(Trip)
            .findOneByOrFail({ id: result.tripRequest.tripId! })
        ).availableSeats,
      ).toBe(0);
      expect((await service.findRequestPage(other.id, false, {})).data).toEqual(
        [],
      );
      await expect(service.findOne(r.id, other.id)).rejects.toThrow();
    },
  );

  it('in-app refusal without delivery only hides the request for that driver', async () => {
    const c = context(),
      first = await c.driver(),
      second = await c.driver(),
      r = await c.request(true);
    const service = serviceFor(c);
    await declineRequestForDriver(c.db.manager, first.id, r.id);
    expect((await service.findRequestPage(first.id, false, {})).data).toEqual(
      [],
    );
    await expect(service.findOne(r.id, first.id)).rejects.toThrow();
    expect(
      (await service.findRequestPage(second.id, false, {})).data.map(
        (row) => row.id,
      ),
    ).toContain(r.id);
    await expect(
      service.acceptTripRequest(first.id, r.id, {}),
    ).rejects.toThrow();
    expect(await c.db.getRepository(Trip).count()).toBe(0);
  });

  it('ringing expiry and another current recipient do not block a former recipient in-app', async () => {
    const c = context(),
      first = await c.driver(),
      second = await c.driver(15.311),
      r = await c.request(true);
    await c.relay.advance(r.id);
    await c.db.query(
      `UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`,
      [r.id],
    );
    await c.relay.deadlines();
    expect(
      (await c.offers(r.id)).find((row) => row.status === 'pending').driverId,
    ).toBe(second.id);
    const service = serviceFor(c);
    expect(
      (await service.findOne(r.id, first.id)).responseWindow,
    ).toBeUndefined();
    const vehicle = await c.db
      .getRepository(Vehicle)
      .findOneByOrFail({ ownerId: first.id });
    await service.acceptTripRequest(first.id, r.id, { vehicleId: vehicle.id });
    expect((await c.offers(r.id)).map((row) => row.status).sort()).toEqual([
      'accepted',
      'cancelled',
    ]);
    expect(await c.db.getRepository(Booking).count()).toBe(1);
  });

  it('one driver may receive an unrelated alert while claiming a visible request; two claimants cannot both win', async () => {
    const c = context(),
      first = await c.driver(),
      second = await c.driver(15.311),
      r = await c.request();
    const unrelated = await c.request(false, first.id);
    await c.relay.advance(unrelated.id);
    const vehicles = await Promise.all(
      [first, second].map((user) =>
        c.db.getRepository(Vehicle).findOneByOrFail({ ownerId: user.id }),
      ),
    );
    const results = await Promise.allSettled(
      [first, second].map((user, index) =>
        claimRequestAcceptance(c.db.manager, r, user.id, {
          vehicleId: vehicles[index].id,
          seats: 1,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      (await c.offers(r.id)).filter((row) => row.status === 'pending'),
    ).toHaveLength(1);
    expect((await c.offers(unrelated.id))[0].status).toBe('pending');
    const service = serviceFor(c);
    expect((await service.findOne(r.id, second.id)).responseWindow?.phase).toBe(
      'accepting',
    );
  });

  it('targeting, ownership and real request expiration remain enforced without invitation gating', async () => {
    const c = context(),
      first = await c.driver(),
      second = await c.driver(),
      r = await c.request(true, first.id);
    const service = serviceFor(c);
    expect((await service.findRequestPage(second.id, false, {})).data).toEqual(
      [],
    );
    await expect(service.findOne(r.id, second.id)).rejects.toThrow();
    await expect(
      service.acceptTripRequest(second.id, r.id, {}),
    ).rejects.toThrow();
    expect((await service.findOne(r.id, first.id)).id).toBe(r.id);
    await c.db
      .getRepository(TripRequest)
      .update(r.id, { passengerId: first.id, targetDriverId: null });
    expect((await service.findRequestPage(first.id, false, {})).data).toEqual(
      [],
    );
    await expect(
      service.acceptTripRequest(first.id, r.id, {}),
    ).rejects.toThrow();
    await c.db
      .getRepository(TripRequest)
      .update(r.id, { departureDateMax: new Date(Date.now() - 4 * 3600000) });
    expect((await service.findRequestPage(second.id, false, {})).data).toEqual(
      [],
    );
  });
}
