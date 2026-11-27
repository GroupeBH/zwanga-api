import { Repository } from 'typeorm';
import { Booking, BookingStatus, BookingPaymentStatus } from './entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { lockTripBookingCreation } from './bookable-trip-transaction';

/** Missing amounts are not free rides; mixed token/cash still needs a cash receipt. */
export function allRequestPassengersArrivedAndPaid(bookings: Booking[]): boolean {
  const participants = bookings.filter(booking => [BookingStatus.PENDING, BookingStatus.ACCEPTED,
    BookingStatus.BOARDING_UNCERTAIN, BookingStatus.COMPLETED].includes(booking.status));
  return participants.length > 0 && participants.every(booking => {
    if (booking.status !== BookingStatus.COMPLETED || !booking.droppedOff) return false;
    const amount = booking.paymentAmount;
    const free = amount !== null && amount !== undefined && String(amount).trim() !== '' && Number(amount) === 0;
    if (free) return true;
    if (booking.paymentMode === 'cash') return Boolean(booking.cashReceivedAt);
    return booking.paymentStatus === BookingPaymentStatus.SUCCEEDED;
  });
}

/** Booking creation gate -> bookings -> trip, identical to manual completion. No external I/O. */
export async function completePaidRequestTransaction(repository: Repository<Trip>, tripId: string, now: Date): Promise<Trip | null> {
  return repository.manager.transaction(async manager => {
    await lockTripBookingCreation(manager, tripId);
    const bookings = await manager.find(Booking, { where: { tripId }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } });
    // Arrival declarations still lock trip -> booking. Defer a busy trip rather
    // than deadlocking that transaction; GPS/receipt replay/manual recovery retries.
    const trip = await manager.findOne(Trip, { where: { id: tripId }, lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' } });
    if (!trip?.tripRequestId || trip.status !== TripStatus.ACTIVE || !allRequestPassengersArrivedAndPaid(bookings)) return null;
    await manager.update(Trip, { id: tripId, status: TripStatus.ACTIVE }, { id: tripId, status: TripStatus.COMPLETED, completedAt: now });
    return Object.assign(trip, { status: TripStatus.COMPLETED, completedAt: now });
  });
}
