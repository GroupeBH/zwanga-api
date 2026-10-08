import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TripRequestsService } from './trip-requests.service';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

describe('Editing and reopening requests', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const future = {
    departureDateMin: '2026-10-08T14:00:00Z',
    departureDateMax: '2026-10-08T15:00:00Z',
  };
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());

  function build(overrides: Partial<TripRequest> = {}) {
    const request = {
      id: 'request',
      passengerId: 'passenger',
      status: TripRequestStatus.PENDING,
      departureDateMin: new Date('2026-10-08T12:10:00Z'),
      departureDateMax: new Date('2026-10-08T12:30:00Z'),
      departureLocation: 'Gombe',
      arrivalLocation: 'Limete',
      numberOfSeats: 1,
      vehicleType: VehicleType.CAR,
      paymentMode: TripPaymentMode.CASH,
      maxPricePerSeat: 5000,
      updatedAt: new Date('2026-10-08T11:59:00Z'),
      selectedDriverId: null,
      tripId: null,
      driverOffers: [],
      immediateDispatch: false,
      expirationNotificationSent: true,
      ...overrides,
    } as TripRequest;
    const locked = {
      findOne: jest.fn(async () => ({ ...request })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const offers = {
      exists: jest.fn().mockResolvedValue(false),
      update: jest.fn(),
    };
    const trips = { exists: jest.fn().mockResolvedValue(false) };
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };
    const repository = {
      findOne: jest.fn(async () => ({ ...request })),
      manager: {
        transaction: jest.fn(async (work) =>
          work({
            getRepository: (entity: unknown) =>
              entity === TripRequest
                ? locked
                : entity === DriverOffer
                  ? offers
                  : trips,
            createQueryBuilder: () => qb,
          }),
        ),
      },
    };
    const tick = jest.fn().mockResolvedValue(undefined);
    const service = new TripRequestsService(
      repository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    Object.assign(service, { driverDispatch: { tick } });
    jest
      .spyOn(service as any, 'ensurePassengerKycForExtraSeatsById')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: request.id } as any);
    return { service, request, repository, locked, offers, trips, qb, tick };
  }

  it('allows the owner and admin delegate to edit an immediate request, invalidating pending offers only', async () => {
    const ctx = build({ immediateDispatch: true });
    await ctx.service.update(
      'passenger',
      'request',
      {
        description: 'Nouveau repère',
        expectedUpdatedAt: ctx.request.updatedAt.toISOString(),
      },
      'admin',
    );
    expect(ctx.repository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'request', passengerId: 'passenger' },
      }),
    );
    expect(ctx.locked.findOne).toHaveBeenCalledWith({
      where: { id: 'request' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(ctx.locked.update).toHaveBeenCalledWith('request', {
      description: 'Nouveau repère',
      status: TripRequestStatus.PENDING,
    });
    expect(ctx.offers.update).toHaveBeenCalledWith(
      { tripRequestId: 'request', status: DriverOfferStatus.PENDING },
      { status: DriverOfferStatus.REJECTED, rejectedAt: now },
    );
    expect(ctx.qb.set).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(ctx.tick).toHaveBeenCalledTimes(1);
  });

  it.each([TripRequestStatus.EXPIRED, TripRequestStatus.PENDING])(
    'reopens %s with a future window and resets its warning, without reviving old dispatch',
    async (status) => {
      const ctx = build({
        status,
        immediateDispatch: true,
        departureDateMin: new Date('2026-10-08T07:00:00Z'),
        departureDateMax: new Date('2026-10-08T08:00:00Z'),
      });
      await ctx.service.update('passenger', 'request', future);
      expect(ctx.locked.update).toHaveBeenCalledWith('request', {
        departureDateMin: new Date(future.departureDateMin),
        departureDateMax: new Date(future.departureDateMax),
        status: TripRequestStatus.PENDING,
        immediateDispatch: false,
        expirationNotificationSent: false,
      });
      expect(ctx.tick).not.toHaveBeenCalled();
    },
  );

  it.each([
    { description: 'Sans date' },
    { ...future, departureDateMin: 'invalid' },
    { ...future, departureDateMin: '2026-10-08T11:00:00Z' },
    { ...future, departureDateMax: future.departureDateMin },
  ])('requires a complete valid future window to reopen: %j', async (dto) => {
    const ctx = build({ status: TripRequestStatus.EXPIRED });
    await expect(
      ctx.service.update('passenger', 'request', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.locked.update).not.toHaveBeenCalled();
  });

  it.each([
    { status: TripRequestStatus.CANCELLED },
    { selectedDriverId: 'driver' },
    { tripId: 'trip' },
    { driverOffers: [{ status: DriverOfferStatus.ACCEPTED }] },
  ])('does not edit an engaged or cancelled request: %j', async (override) => {
    const ctx = build(override as Partial<TripRequest>);
    await expect(
      ctx.service.update('passenger', 'request', future),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.repository.manager.transaction).not.toHaveBeenCalled();
  });

  it('does not overwrite a concurrent acceptance after geocoding or an outdated form', async () => {
    const ctx = build();
    ctx.locked.findOne.mockResolvedValue({
      ...ctx.request,
      status: TripRequestStatus.DRIVER_SELECTED,
      selectedDriverId: 'driver',
    });
    await expect(
      ctx.service.update('passenger', 'request', { description: 'Changed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      ctx.service.update('passenger', 'request', {
        description: 'Changed',
        expectedUpdatedAt: '2026-10-08T11:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.locked.update).not.toHaveBeenCalled();
    expect(ctx.offers.update).not.toHaveBeenCalled();
  });

  it.each(['trips', 'offers'] as const)(
    'blocks a committed %s assignment whose request link is not filled yet',
    async (field) => {
      const ctx = build();
      ctx[field].exists.mockResolvedValue(true);
      await expect(
        ctx.service.update('passenger', 'request', { description: 'Changed' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ctx.locked.update).not.toHaveBeenCalled();
    },
  );

  it('accepts unchanged past start time within the grace period and does not erase unrelated fields', async () => {
    const ctx = build({ departureDateMin: new Date('2026-10-08T11:00:00Z') });
    await ctx.service.update('passenger', 'request', {
      departureDateMin: ctx.request.departureDateMin.toISOString(),
      description: 'Updated',
    });
    expect(ctx.locked.update).toHaveBeenCalledWith('request', {
      description: 'Updated',
      status: TripRequestStatus.PENDING,
    });
  });

  it('does not invalidate offers on an unchanged form', async () => {
    const ctx = build();
    await ctx.service.update('passenger', 'request', { numberOfSeats: 1 });
    expect(ctx.repository.manager.transaction).not.toHaveBeenCalled();
  });

  it('rejects another user before any write', async () => {
    const ctx = build();
    ctx.repository.findOne.mockResolvedValue(null as any);
    await expect(
      ctx.service.update('other', 'request', future),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.repository.manager.transaction).not.toHaveBeenCalled();
  });
});
