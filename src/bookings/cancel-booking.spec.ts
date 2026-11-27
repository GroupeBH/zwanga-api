import {
  assertBookingCanBeCancelled,
  cancelBookingBeforePickup,
} from './cancel-booking';
import { Booking, BookingStatus } from './entities/booking.entity';
import { Trip } from '../trips/entities/trip.entity';

const booking = (patch = {}) =>
  ({
    id: 'booking',
    passengerId: 'passenger',
    tripId: 'trip',
    status: BookingStatus.ACCEPTED,
    ...patch,
  }) as Booking;
const trip = { id: 'trip', driverId: 'driver' } as Trip;
describe('cancellation before pickup only', () => {
  it.each(['passenger', 'driver'])(
    'allows %s cancellation before pickup',
    (user) => {
      expect(() =>
        assertBookingCanBeCancelled(booking(), trip, user),
      ).not.toThrow();
    },
  );
  it.each([
    'pickedUp',
    'pickedUpAt',
    'pickedUpConfirmedByPassenger',
    'pickedUpConfirmedAt',
    'droppedOff',
    'droppedOffAt',
    'droppedOffConfirmedByPassenger',
  ])('blocks passenger cancellation with %s', (flag) => {
    expect(() =>
      assertBookingCanBeCancelled(booking({ [flag]: true }), trip, 'passenger'),
    ).toThrow();
  });
  it.each(['driver', 'passenger'])(
    'blocks an unresolved pickup declaration from %s',
    (actor) => {
      expect(() =>
        assertBookingCanBeCancelled(
          booking({
            rideDeclarations: { pickup: { [actor]: { decision: 'confirm' } } },
          }),
          trip,
          'passenger',
        ),
      ).toThrow();
    },
  );
  it.each([
    BookingStatus.CANCELLED,
    BookingStatus.REJECTED,
    BookingStatus.COMPLETED,
    BookingStatus.BOARDING_UNCERTAIN,
  ])('does not repeat refunds for %s', (status) => {
    expect(() =>
      assertBookingCanBeCancelled(booking({ status }), trip, 'passenger'),
    ).toThrow();
  });
  it('rechecks authoritative pickup under locks instead of the initial read', async () => {
    const qb: any = {
      getOne: jest.fn().mockResolvedValue(booking({ pickedUp: true })),
    };
    for (const method of ['addSelect', 'where', 'setLock'])
      qb[method] = jest.fn().mockReturnValue(qb);
    const manager: any = {
      findOne: jest.fn().mockResolvedValue(trip),
      getRepository: () => ({ createQueryBuilder: () => qb }),
      save: jest.fn(),
    };
    const repo: any = {
      findOne: jest.fn().mockResolvedValue(booking()),
      manager: { transaction: async (work) => work(manager) },
    };
    const release = jest.fn();
    await expect(
      cancelBookingBeforePickup(repo, 'booking', 'passenger', release),
    ).rejects.toThrow();
    expect(manager.findOne).toHaveBeenCalledWith(
      Trip,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(manager.save).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
