import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TripsService } from './trips.service';
import { Trip, TripStatus } from './entities/trip.entity';
import { BookingStatus } from '../bookings/entities/booking.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { canReprogramTrip } from './trip-reprogram-policy';

describe('Reprogram an expired public trip without altering its history', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());
  function build(extra: Partial<Trip> = {}) {
    const source = {
      id: 'old',
      driverId: 'driver',
      status: TripStatus.COMPLETED,
      departureDate: new Date('2026-10-08T08:00:00Z'),
      startedAt: null,
      isPrivate: false,
      departureLocation: 'Gombe',
      arrivalLocation: 'Limete',
      totalSeats: 3,
      availableSeats: 2,
      pricePerSeat: 5000,
      vehicleId: 'vehicle',
      acceptedPaymentModes: [TripPaymentMode.CASH],
      requiresPassengerKyc: false,
      description: 'Bagage léger',
      bookings: [{ id: 'old-booking', status: BookingStatus.CANCELLED }],
      ...extra,
    } as Trip;
    const service = Object.create(TripsService.prototype) as TripsService;
    const repository = {
      findOne: jest.fn().mockResolvedValue(source),
      save: jest.fn(),
      update: jest.fn(),
    };
    Object.assign(service, { tripRepository: repository });
    const create = jest
      .spyOn(service, 'create')
      .mockResolvedValue({ id: 'new' } as any);
    return { source, service, repository, create };
  }
  const dto = { departureDate: '2026-10-09T08:00:00Z', pricePerSeat: 6000 };

  it('republishes using all normal publication checks and preserves old reservations/payment history', async () => {
    const ctx = build();
    const before = JSON.stringify(ctx.source);
    await expect(ctx.service.reprogram('old', 'driver', dto)).resolves.toEqual({
      id: 'new',
    });
    expect(ctx.repository.findOne).toHaveBeenCalledWith({
      where: { id: 'old', driverId: 'driver' },
      relations: ['bookings'],
    });
    expect(ctx.create).toHaveBeenCalledWith(
      'driver',
      expect.objectContaining({
        ...dto,
        totalSeats: 3,
        vehicleId: 'vehicle',
        acceptedPaymentModes: [TripPaymentMode.CASH],
        departureLocation: 'Gombe',
      }),
    );
    expect(ctx.create.mock.calls[0][1]).not.toHaveProperty('bookings');
    expect(ctx.create.mock.calls[0][1]).not.toHaveProperty('tripRequestId');
    expect(JSON.stringify(ctx.source)).toBe(before);
    expect(ctx.repository.save).not.toHaveBeenCalled();
    expect(ctx.repository.update).not.toHaveBeenCalled();
  });

  it.each([
    { startedAt: now },
    { isPrivate: true },
    { tripRequestId: 'request' },
    { status: TripStatus.ACTIVE },
    { status: TripStatus.CANCELLED },
    { departureDate: new Date('2026-10-09T08:00:00Z') },
  ])(
    'rejects a source that is not an expired public departure: %j',
    async (extra) => {
      const ctx = build(extra);
      expect(canReprogramTrip(ctx.source, now.getTime())).toBe(false);
      await expect(
        ctx.service.reprogram('old', 'driver', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: BookingStatus.PENDING },
    { status: BookingStatus.ACCEPTED },
    { status: BookingStatus.CANCELLED, pickedUp: true },
    { status: BookingStatus.COMPLETED, pickedUpConfirmedAt: now },
  ])(
    'refuses active reservations or previously embarked passengers: %j',
    async (booking) => {
      const ctx = build({ bookings: [booking] as any });
      await expect(
        ctx.service.reprogram('old', 'driver', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { departureDate: 'invalid' },
    { departureDate: now.toISOString() },
    { ...dto, status: TripStatus.PENDING },
  ])('requires a new future date and no status override: %j', async (input) => {
    const ctx = build();
    await expect(
      ctx.service.reprogram('old', 'driver', input),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only allows the owner and propagates publication failures without altering the source', async () => {
    const ctx = build();
    ctx.repository.findOne.mockResolvedValueOnce(null);
    await expect(
      ctx.service.reprogram('old', 'other', dto),
    ).rejects.toBeInstanceOf(NotFoundException);
    ctx.create.mockRejectedValue(
      new BadRequestException('Cash désactivé : dette supérieure à 25 jetons'),
    );
    await expect(ctx.service.reprogram('old', 'driver', dto)).rejects.toThrow(
      'Cash désactivé',
    );
    expect(ctx.source.status).toBe(TripStatus.COMPLETED);
    expect(ctx.repository.save).not.toHaveBeenCalled();
  });
});
