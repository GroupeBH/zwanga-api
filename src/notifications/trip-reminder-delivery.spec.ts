import { isTripReminderDeliverable } from './trip-reminder-delivery';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { BookingStatus } from '../bookings/entities/booking.entity';

describe('queued trip reminder eligibility', () => {
  const fixture = () => {
    const date = new Date(Date.now() + 60000);
    const trip = {
      id: 'trip',
      status: TripStatus.PENDING,
      startedAt: null,
      departureDate: date,
      driverId: 'driver',
    };
    const notification: any = {
      userId: 'passenger',
      data: {
        tripId: 'trip',
        bookingId: 'booking',
        departureDate: date.toISOString(),
      },
    };
    const manager: any = {
      findOneBy: jest.fn(async (entity) =>
        entity === Trip ? trip : { status: BookingStatus.ACCEPTED },
      ),
    };
    return { manager, trip, notification };
  };
  it('checks the exact accepted booking belongs to the recipient', async () => {
    const { manager, notification } = fixture();
    expect(await isTripReminderDeliverable(manager, notification)).toBe(true);
    expect(manager.findOneBy.mock.calls[1][1]).toEqual({
      id: 'booking',
      tripId: 'trip',
      passengerId: 'passenger',
      status: BookingStatus.ACCEPTED,
    });
  });
  it.each([TripStatus.ACTIVE, TripStatus.COMPLETED, TripStatus.CANCELLED])(
    'suppresses reminders after status changes to %s',
    async (status) => {
      const { manager, trip, notification } = fixture();
      trip.status = status;
      expect(await isTripReminderDeliverable(manager, notification)).toBe(
        false,
      );
    },
  );
  it('suppresses past, rescheduled and cancelled-booking reminders', async () => {
    const { manager, trip, notification } = fixture();
    trip.departureDate = new Date(Date.now() - 1);
    expect(await isTripReminderDeliverable(manager, notification)).toBe(false);
    trip.departureDate = new Date(Date.now() + 120000);
    expect(await isTripReminderDeliverable(manager, notification)).toBe(false);
    notification.data.departureDate = trip.departureDate.toISOString();
    manager.findOneBy.mockImplementation(async (entity: unknown) =>
      entity === Trip ? trip : null,
    );
    expect(await isTripReminderDeliverable(manager, notification)).toBe(false);
  });
  it('does not query unspecified identities', async () => {
    const { manager, notification } = fixture();
    delete notification.data.tripId;
    expect(await isTripReminderDeliverable(manager, notification)).toBe(false);
    expect(manager.findOneBy).not.toHaveBeenCalled();
  });
});
