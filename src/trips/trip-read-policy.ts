import { ForbiddenException } from '@nestjs/common';
import type { SanitizedTrip } from './trips.service';
import { TripStatus } from './entities/trip.entity';
import { BookingStatus } from '../bookings/entities/booking.entity';

export function publicTripResponse(trip: SanitizedTrip) {
  const driver = trip.driver;
  const vehicle = trip.vehicle;
  return {
    id: trip.id, driverId: trip.driverId, vehicleId: trip.vehicleId,
    departureLocation: trip.departureLocation, departureReference: trip.departureReference,
    arrivalLocation: trip.arrivalLocation, arrivalReference: trip.arrivalReference,
    departureCoordinates: trip.departureCoordinates, arrivalCoordinates: trip.arrivalCoordinates,
    departureDate: trip.departureDate, estimatedArrivalDate: trip.estimatedArrivalDate,
    totalSeats: trip.totalSeats, availableSeats: trip.availableSeats, pricePerSeat: trip.pricePerSeat,
    isFree: trip.isFree, requiresPassengerKyc: trip.requiresPassengerKyc,
    description: trip.description, status: trip.status, isPrivate: trip.isPrivate,
    isFeatured: trip.isFeatured, createdAt: trip.createdAt, updatedAt: trip.updatedAt,
    estimatedDurationSeconds: trip.estimatedDurationSeconds,
    previewArrivalDate: trip.previewArrivalDate, arrivalEstimateSource: trip.arrivalEstimateSource,
    driver: driver ? { id: driver.id, firstName: driver.firstName, lastName: driver.lastName,
      profilePicture: driver.profilePicture, isDriver: driver.isDriver, isPremium: driver.isPremium,
      premiumBadge: driver.premiumBadge, averageRating: driver.averageRating,
      totalRatings: driver.totalRatings } : null,
    vehicle: vehicle ? { id: vehicle.id, type: vehicle.type, brand: vehicle.brand,
      model: vehicle.model, color: vehicle.color, photoUrl: vehicle.photoUrl } : null,
    // Lists are discovery, never a live tracking or passenger directory API.
    bookings: [], currentLocation: null, lastLocationUpdateAt: null,
  };
}

export function tripResponseForViewer(trip: SanitizedTrip, viewerId: string,
  access: { driverId: string; isPrivate: boolean; status: TripStatus; bookings: { id: string; passengerId: string; status: BookingStatus }[] }) {
  const isDriver = access.driverId === viewerId;
  const ownBookings = access.bookings.filter(booking => booking.passengerId === viewerId);
  if (!viewerId || (access.isPrivate && !isDriver && !ownBookings.length)) {
    throw new ForbiddenException('Accès à ce trajet refusé.');
  }
  if (isDriver) return trip;
  const visible = { ...publicTripResponse(trip), isPrivate: access.isPrivate, status: access.status };
  if (!ownBookings.length) return visible;
  const canTrack = ownBookings.some(booking => booking.status === BookingStatus.ACCEPTED);
  return {
    ...visible,
    bookings: trip.bookings.flatMap(booking => {
      const current = ownBookings.find(own => own.id === booking.id);
      return current ? [{ ...booking, status: current.status }] : [];
    }),
    driver: canTrack ? trip.driver : visible.driver,
    vehicle: canTrack ? trip.vehicle : visible.vehicle,
    startedAt: trip.startedAt, completedAt: trip.completedAt,
    currentLocation: canTrack && access.status === TripStatus.ACTIVE ? trip.currentLocation : null,
    lastLocationUpdateAt: canTrack && access.status === TripStatus.ACTIVE ? trip.lastLocationUpdateAt : null,
    // Passengers need the current interruption request to vote/stop their own ride.
    interruptionRequest: trip.interruptionRequest ? { ...trip.interruptionRequest,
      confirmations: trip.interruptionRequest.confirmations?.filter(item => item.passengerId === viewerId),
    } : null,
  };
}
