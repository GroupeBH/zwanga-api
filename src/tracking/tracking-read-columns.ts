import type { FindOptionsSelect } from 'typeorm';
import type { Trip } from '../trips/entities/trip.entity';

// Reference projection for regression comparisons with read-tracking-location.
// Never save these partial entities or use them for payments or cached responses.
export const DRIVER_TRACKING_SELECT: FindOptionsSelect<Trip> = {
  id: true,
  driverId: true,
  status: true,
  currentLocation: true,
  lastLocationUpdateAt: true,
  departurePoint: true,
  arrivalPoint: true,
};

// REST ingestion also checks one-time proximity notifications before reloading
// full state for automatic progression. Keep all fields of those guards.
export const PASSENGER_TRACKING_COLUMNS = [
  'booking.id', 'booking.tripId', 'booking.passengerId', 'booking.status',
  'booking.passengerCurrentLocation', 'booking.passengerLastLocationUpdateAt',
  'booking.passengerDestinationPoint', 'booking.destinationProximityNotified',
  'booking.pickedUp', 'booking.pickedUpAt', 'booking.pickedUpConfirmedByPassenger',
  'booking.pickedUpConfirmedAt', 'booking.droppedOff', 'booking.droppedOffAt',
  'booking.droppedOffConfirmedByPassenger', 'booking.droppedOffConfirmedAt',
  'trip.id', 'trip.status', 'trip.departurePoint', 'trip.arrivalPoint',
];
