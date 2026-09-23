import { DriverInterruptionWorkflow } from './driver-interruption.workflow';
import { Trip, TripStatus } from './entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import {
  DriverTripInterruptionRequest as Interruption,
  DriverTripInterruptionConfirmation as Confirmation,
} from './entities/trip-interruption.entity';
import { calculateInterruptionFare } from '../bookings/interruption-fare';

function fixture() {
  const trip: any = {
    id: 'trip',
    driverId: 'driver',
    status: TripStatus.ACTIVE,
    totalSeats: 3,
    availableSeats: 0,
    startedAt: new Date('2026-09-13T10:00:00Z'),
    currentLocation: { type: 'Point', coordinates: [15.3, -4.3] },
  };
  const request: any = {
    id: 'request',
    tripId: trip.id,
    status: 'pending',
    requiredPassengerCount: 2,
    requestedLocation: trip.currentLocation,
  };
  const bookings: any[] = [1, 2].map((n) => ({
    id: `booking-${n}`,
    tripId: trip.id,
    passengerId: `passenger-${n}`,
    status: BookingStatus.ACCEPTED,
    pickedUp: true,
    numberOfSeats: n,
    paymentAmount: 10000,
  }));
  const confirmations: any[] = bookings.map((booking) => ({
    id: booking.id,
    requestId: request.id,
    tripId: trip.id,
    bookingId: booking.id,
    passengerId: booking.passengerId,
    status: 'pending',
    decision: null,
    fareQuote: null,
  }));
  const matches = (item: any, where: any): boolean =>
    Array.isArray(where)
      ? where.some((part) => matches(item, part))
      : Object.entries(where).every(([key, value]) => item[key] === value);
  let queue = Promise.resolve();
  const manager: any = {
    transaction: jest.fn((callback) => {
      const result = queue.then(() => callback(manager));
      queue = result.catch(() => undefined);
      return result;
    }),
    findOne: jest.fn(
      async (entity, options) =>
        (entity === Trip
          ? [trip]
          : entity === Interruption
            ? [request]
            : bookings
        ).find((item) => matches(item, options.where)) ?? null,
    ),
    find: jest.fn(async () => confirmations),
    save: jest.fn(async (_entity, item) => item),
    update: jest.fn(async (_entity, where, patch) => {
      confirmations
        .filter((item) => matches(item, where))
        .forEach((item) => Object.assign(item, patch));
    }),
    getRepository: () => ({
      createQueryBuilder: () => {
        let params: any;
        const query: any = {
          addSelect: () => query,
          where: (_sql: string, args: any) => {
            params = args;
            return query;
          },
          getOne: async () =>
            confirmations.find(
              (item) =>
                item.requestId === params.requestId &&
                item.bookingId === params.bookingId &&
                item.passengerId === params.passengerId,
            ) ?? null,
          orderBy: () => query,
          take: () => query,
          getMany: async () =>
            confirmations.filter(
              (item) => item.decision === 'stop' && !item.settledAt,
            ),
        };
        return query;
      },
    }),
  };
  const bookingService: any = {
    quoteDriverInterruptionFare: jest.fn(async () => ({
      ...calculateInterruptionFare(10000, 10000, 25000, 5000),
      prepaidAmount: 0,
    })),
    applyDriverInterruptionFare: jest.fn(async (booking, quote) => {
      booking.status = BookingStatus.COMPLETED;
      booking.droppedOff = true;
      booking.paymentAmount = quote.passengerAmount;
    }),
    settleDriverInterruptionFare: jest.fn(async () => undefined),
  };
  const service = new DriverInterruptionWorkflow(manager, bookingService);
  const args = (n: number) => ({
    requestId: request.id,
    bookingId: `booking-${n}`,
  });
  const pause = async () => {
    await Promise.all([
      service.respond(trip.id, 'passenger-1', 'booking-1', true),
      service.respond(trip.id, 'passenger-2', 'booking-2', true),
    ]);
  };
  const quote = (n = 1) => service.quote(trip.id, `passenger-${n}`, args(n));
  const wait = (n = 1) =>
    service.decide(trip.id, `passenger-${n}`, { ...args(n), decision: 'wait' });
  return {
    trip,
    request,
    bookings,
    confirmations,
    manager,
    bookingService,
    service,
    args,
    pause,
    quote,
    wait,
  };
}

describe('DriverInterruptionWorkflow', () => {
  it('serializes confirmations and pauses only when all onboard passengers confirmed, without completing bookings', async () => {
    const f = fixture();
    await f.service.respond('trip', 'passenger-1', 'booking-1', true);
    expect(f.trip.status).toBe(TripStatus.ACTIVE);
    await f.pause();
    expect(f.request.status).toBe('confirmed');
    expect(f.trip.status).toBe(TripStatus.PENDING);
    expect(f.trip.availableSeats).toBe(0);
    expect(
      f.bookings.every((booking) => booking.status === BookingStatus.ACCEPTED),
    ).toBe(true);
    expect(f.bookingService.applyDriverInterruptionFare).not.toHaveBeenCalled();
    expect(
      f.bookingService.settleDriverInterruptionFare,
    ).not.toHaveBeenCalled();
  });
  it('waiting keeps the booking and seat, including when the quote service is unavailable', async () => {
    const f = fixture();
    await f.pause();
    f.bookingService.quoteDriverInterruptionFare.mockRejectedValue(
      new Error('unavailable'),
    );
    await f.wait();
    expect(f.confirmations[0].decision).toBe('wait');
    expect(f.trip.availableSeats).toBe(0);
    expect(f.bookings[0].status).toBe(BookingStatus.ACCEPTED);
    expect(
      f.bookingService.settleDriverInterruptionFare,
    ).not.toHaveBeenCalled();
  });
  it('stores one immutable quote and rejects another passenger before calculating it', async () => {
    const f = fixture();
    await f.pause();
    await expect(
      f.service.quote('trip', 'stranger', f.args(1)),
    ).rejects.toThrow();
    expect(f.bookingService.quoteDriverInterruptionFare).not.toHaveBeenCalled();
    const quote = await f.quote();
    expect(await f.quote()).toEqual(quote);
    expect(f.bookingService.quoteDriverInterruptionFare).toHaveBeenCalledTimes(
      1,
    );
    expect(f.bookingService.quoteDriverInterruptionFare).toHaveBeenCalledWith(
      'booking-1',
      f.request.requestedLocation,
    );
  });
  it('requires the displayed quote before stopping', async () => {
    const f = fixture();
    await f.pause();
    await f.quote();
    await expect(
      f.service.decide('trip', 'passenger-1', {
        ...f.args(1),
        decision: 'stop',
        quoteId: 'wrong',
      }),
    ).rejects.toThrow();
    expect(f.bookingService.applyDriverInterruptionFare).not.toHaveBeenCalled();
  });
  it('stops only the deciding passenger and restarts with waiting passengers and their original start time', async () => {
    const f = fixture();
    await f.pause();
    const originalStart = f.trip.startedAt;
    const quote = await f.quote();
    await f.service.decide('trip', 'passenger-1', {
      ...f.args(1),
      decision: 'stop',
      quoteId: quote.id,
    });
    expect(f.trip.availableSeats).toBe(1);
    expect(f.bookings[0].paymentAmount).toBe(2000);
    expect(f.bookings[1].status).toBe(BookingStatus.ACCEPTED);
    await expect(f.service.resume('trip', 'driver')).rejects.toThrow();
    await f.wait(2);
    await expect(f.service.resume('trip', 'driver')).resolves.toBe(true);
    expect(f.trip.startedAt).toBe(originalStart);
    expect(f.trip.status).toBe(TripStatus.ACTIVE);
    expect(f.request.status).toBe('completed');
    await expect(
      f.service.decide('trip', 'passenger-2', {
        ...f.args(2),
        decision: 'stop',
      }),
    ).rejects.toThrow();
  });
  it('handles repeated stop clicks once, without an artificial refund after paying the reduced fare', async () => {
    const f = fixture();
    await f.pause();
    const quote = await f.quote();
    const dto = { ...f.args(1), decision: 'stop' as const, quoteId: quote.id };
    await f.service.decide('trip', 'passenger-1', dto);
    await f.service.decide('trip', 'passenger-1', dto);
    expect(f.bookingService.applyDriverInterruptionFare).toHaveBeenCalledTimes(
      1,
    );
    expect(f.bookingService.settleDriverInterruptionFare).toHaveBeenCalledTimes(
      1,
    );
    expect(f.bookingService.settleDriverInterruptionFare).toHaveBeenCalledWith(
      'booking-1',
      0,
    );
    expect(f.trip.availableSeats).toBe(1);
  });
  it('allows changing from waiting to stopping while still paused', async () => {
    const f = fixture();
    await f.pause();
    await f.wait();
    const quote = await f.quote();
    await f.service.decide('trip', 'passenger-1', {
      ...f.args(1),
      decision: 'stop',
      quoteId: quote.id,
    });
    expect(f.confirmations[0].decision).toBe('stop');
  });
  it('retries a committed settlement after a transient failure without completing the booking again', async () => {
    const f = fixture();
    await f.pause();
    const quote = await f.quote();
    f.bookingService.settleDriverInterruptionFare.mockRejectedValueOnce(
      new Error('temporary'),
    );
    await expect(
      f.service.decide('trip', 'passenger-1', {
        ...f.args(1),
        decision: 'stop',
        quoteId: quote.id,
      }),
    ).rejects.toThrow();
    expect(f.confirmations[0].decision).toBe('stop');
    await f.service.retryPendingSettlements(jest.fn());
    expect(f.confirmations[0].settledAt).toBeInstanceOf(Date);
    expect(f.bookingService.applyDriverInterruptionFare).toHaveBeenCalledTimes(
      1,
    );
  });
  it('does not let a cancellation undo an already confirmed pause', async () => {
    const f = fixture();
    await f.pause();
    await expect(f.service.cancel('trip', 'driver')).rejects.toThrow();
    await expect(f.service.resume('trip', 'stranger')).rejects.toThrow();
    expect(f.request.status).toBe('confirmed');
  });
});
