import { join } from 'path';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { BookingsService } from './bookings.service';
import { Booking, BookingStatus } from './entities/booking.entity';

// Exercise the production method and real TypeORM SQL generation. No application
// configuration, database connection or push provider is used by this suite.
describe('destination proximity: PostgreSQL query and notification boundaries', () => {
  let source: DataSource;
  let raw: jest.SpyInstance;
  let update: jest.Mock;
  let notify: jest.Mock;
  let logger: { log: jest.Mock; error: jest.Mock };
  let service: {
    calculateDistanceToDestination(booking: Booking): Promise<number | null>;
    checkAndNotifyDestinationProximity(booking: Booking): Promise<void>;
  };
  const makeBooking = () =>
    ({
      id: 'c84184ba-1f47-42ac-aed7-32f4a08f80c0',
      tripId: 'test-trip',
      passengerId: 'test-passenger',
      status: BookingStatus.ACCEPTED,
      passengerCurrentLocation: { type: 'Point', coordinates: [15.3, -4.3] },
      passengerDestinationPoint: { type: 'Point', coordinates: [15.3, -4.3] },
      destinationProximityNotified: false,
    }) as Booking;

  beforeAll(async () => {
    source = new DataSource({
      type: 'postgres',
      database: 'metadata_only',
      entities: [join(__dirname, '../**/*.entity.ts')],
    });
    await (
      source as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
  });

  beforeEach(() => {
    raw = jest
      .spyOn(SelectQueryBuilder.prototype, 'getRawOne')
      .mockResolvedValue({ distance: 100 });
    update = jest.fn().mockResolvedValue({ affected: 1 });
    notify = jest.fn().mockResolvedValue(undefined);
    logger = { log: jest.fn(), error: jest.fn() };
    service = Object.assign(Object.create(BookingsService.prototype), {
      bookingRepository: {
        createQueryBuilder: () =>
          source.getRepository(Booking).createQueryBuilder('booking'),
        update,
      },
      logger,
      DESTINATION_PROXIMITY_THRESHOLD_METERS: 1000,
      notifyDestinationProximity: notify,
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('quotes both camelCase geography columns and binds the booking ID with real metadata', async () => {
    let generatedSql = '';
    let parameters: unknown[] = [];
    raw.mockImplementation(async function (this: SelectQueryBuilder<Booking>) {
      [generatedSql, parameters] = this.getQueryAndParameters();
      return { distance: 0 };
    });
    const booking = makeBooking();
    await service.calculateDistanceToDestination(booking);

    expect(generatedSql).toContain(
      '"booking"."passengerCurrentLocation"::geography',
    );
    expect(generatedSql).toContain(
      '"booking"."passengerDestinationPoint"::geography',
    );
    expect(generatedSql).toContain('WHERE "booking"."id" = $1');
    expect(generatedSql).not.toContain(booking.id);
    expect(parameters).toEqual([booking.id]);
    expect(source.isInitialized).toBe(false);
  });

  it.each([
    [0, 0],
    ['0', 0],
    [0.4, 0],
    [123.6, 124],
    ['123.6', 124],
  ])(
    'accepts a finite distance of %p metres, including arrival at zero',
    async (distance, expected) => {
      raw.mockResolvedValue({ distance });
      await expect(
        service.calculateDistanceToDestination(makeBooking()),
      ).resolves.toBe(expected);
    },
  );

  it.each([
    null,
    undefined,
    '',
    ' ',
    'invalid',
    NaN,
    Infinity,
    -1,
    '-1',
    false,
  ])(
    'does not turn an absent/invalid distance %p into an arrival',
    async (distance) => {
      raw.mockResolvedValue({ distance });
      await expect(
        service.calculateDistanceToDestination(makeBooking()),
      ).resolves.toBeNull();
      await service.checkAndNotifyDestinationProximity(makeBooking());
      expect(update).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it('does not infer a distance when the booking row is missing', async () => {
    raw.mockResolvedValue(undefined);
    await expect(
      service.calculateDistanceToDestination(makeBooking()),
    ).resolves.toBeNull();
  });

  it.each(['passengerCurrentLocation', 'passengerDestinationPoint'] as const)(
    'does not issue a query without %s',
    async (field) => {
      const booking = makeBooking();
      booking[field] = null;
      await expect(
        service.calculateDistanceToDestination(booking),
      ).resolves.toBeNull();
      expect(raw).not.toHaveBeenCalled();
    },
  );

  it('notifies once at exactly zero metres without completing or boarding the ride', async () => {
    const booking = makeBooking();
    raw.mockResolvedValue({ distance: 0 });
    await service.checkAndNotifyDestinationProximity(booking);
    await service.checkAndNotifyDestinationProximity(booking);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      {
        id: booking.id,
        status: BookingStatus.ACCEPTED,
        destinationProximityNotified: false,
      },
      { destinationProximityNotified: true },
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(booking, 0);
    expect(booking.status).toBe(BookingStatus.ACCEPTED);
    expect(booking.pickedUp).toBeUndefined();
    expect(booking.droppedOff).toBeUndefined();
  });

  it('retains the one-kilometre proximity threshold', async () => {
    raw.mockResolvedValueOnce({ distance: 1001 });
    await service.checkAndNotifyDestinationProximity(makeBooking());
    expect(notify).not.toHaveBeenCalled();
    raw.mockResolvedValueOnce({ distance: 1000 });
    await service.checkAndNotifyDestinationProximity(makeBooking());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not notify or mark the in-memory booking if another request claimed the notification', async () => {
    const first = makeBooking();
    const concurrent = makeBooking();
    update
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });
    await Promise.all([
      service.checkAndNotifyDestinationProximity(first),
      service.checkAndNotifyDestinationProximity(concurrent),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(first.destinationProximityNotified).toBe(true);
    expect(concurrent.destinationProximityNotified).toBe(false);
  });

  it('does not mark the in-memory booking when the persistence attempt fails', async () => {
    const booking = makeBooking();
    update.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      service.checkAndNotifyDestinationProximity(booking),
    ).rejects.toThrow('database unavailable');
    expect(booking.destinationProximityNotified).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('allows GPS processing to continue on a distance query failure and retries on the next sample', async () => {
    const booking = makeBooking();
    raw.mockRejectedValueOnce(new Error('query unavailable'));
    await expect(
      service.checkAndNotifyDestinationProximity(booking),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(booking.destinationProximityNotified).toBe(false);
    await service.checkAndNotifyDestinationProximity(booking);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
