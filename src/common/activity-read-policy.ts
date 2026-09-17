import { In, MoreThanOrEqual, type FindOptionsWhere } from 'typeorm';
import { Booking, BookingStatus, BookingPaymentStatus } from '../bookings/entities/booking.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';

// Preserve all unfinished rides and recent payment/interruptions; never cap active rides by count.
export function activeBookingWhere(passengerId: string, now = Date.now()): FindOptionsWhere<Booking>[] {
  const recent = new Date(now - 48 * 60 * 60_000);
  return [
    { passengerId, status: In([BookingStatus.PENDING, BookingStatus.ACCEPTED, BookingStatus.NO_SHOW, BookingStatus.BOARDING_UNCERTAIN]) },
    { passengerId, updatedAt: MoreThanOrEqual(recent) },
    { passengerId, droppedOffAt: MoreThanOrEqual(recent) },
    { passengerId, paymentStatus: BookingPaymentStatus.INITIATED },
  ];
}

export function activeTripWhere(driverId: string, now = Date.now()): FindOptionsWhere<Trip>[] {
  const recent = new Date(now - 48 * 60 * 60_000);
  return [
    { driverId, status: In([TripStatus.PENDING, TripStatus.ACTIVE]) },
    { driverId, completedAt: MoreThanOrEqual(recent) },
    { driverId, departureDate: MoreThanOrEqual(recent) },
  ];
}
