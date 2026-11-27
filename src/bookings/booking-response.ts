import { NotFoundException } from '@nestjs/common';
import { BookingStatus } from './entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';

type RecordValue = Record<string, unknown>;
export const asRecord = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
/** Explicit allowlists: never spread an entity or cached user into an HTTP response. */
function scalars(value: unknown, keys: string): RecordValue {
  const source = asRecord(value),
    result: RecordValue = {};
  for (const key of keys.split(' ')) {
    const field = source[key];
    if (
      field === null ||
      field instanceof Date ||
      ['string', 'number', 'boolean'].includes(typeof field)
    )
      result[key] = field;
  }
  return result;
}
function point(value: unknown) {
  const coordinates = asRecord(value).coordinates;
  return Array.isArray(coordinates) &&
    coordinates.length === 2 &&
    coordinates.every(Number.isFinite)
    ? { type: 'Point', coordinates: [...(coordinates as number[])] }
    : null;
}
function user(value: unknown, contact: boolean) {
  return value
    ? scalars(
        value,
        'id firstName lastName profilePicture isDriver isPremium premiumBadge averageRating totalRatings' +
          (contact ? ' phone' : ''),
      )
    : null;
}
export interface BookingResponseAccess {
  id: string;
  tripId: string;
  passengerId: string;
  driverId: string;
  status: BookingStatus;
  tripStatus: TripStatus;
  departureDate: Date | string;
  droppedOff: boolean;
  droppedOffAt: Date | string | null;
  droppedOffConfirmedByPassenger: boolean;
  currentLocation: unknown;
  lastLocationUpdateAt: Date | string | null;
  passengerCurrentLocation: unknown;
  passengerLastLocationUpdateAt: Date | string | null;
}
export function canContactBookingDriver(
  status: BookingStatus,
  tripStatus: TripStatus,
): boolean {
  return (
    status === BookingStatus.ACCEPTED &&
    [TripStatus.PENDING, TripStatus.ACTIVE].includes(tripStatus)
  );
}
function interruption(
  value: unknown,
  viewer: string,
  driver: boolean,
): RecordValue | null {
  if (!value) return null;
  const request = asRecord(value);
  return {
    ...scalars(
      request,
      'id tripId bookingId passengerId requestedByDriverId reason note status requestedAt confirmedAt rejectedAt cancelledAt completedAt rejectionReason requiredPassengerCount confirmedPassengerCount rejectedPassengerCount createdAt updatedAt',
    ),
    requestedLocation: point(request.requestedLocation),
    confirmations: Array.isArray(request.confirmations)
      ? request.confirmations
          .map(asRecord)
          .filter((item) => driver || item.passengerId === viewer)
          .map((item) => ({
            ...scalars(
              item,
              'id requestId tripId bookingId passengerId status confirmedAt rejectedAt rejectionReason decision decisionAt settledAt createdAt updatedAt',
            ),
            passenger: user(item.passenger, false),
          }))
      : [],
  };
}
export function bookingResponse(
  value: unknown,
  access: BookingResponseAccess | undefined,
  viewer: string,
) {
  if (
    !access ||
    !viewer ||
    (access.passengerId !== viewer && access.driverId !== viewer)
  )
    throw new NotFoundException('Réservation non trouvée');
  const source = asRecord(value),
    trip = asRecord(source.trip);
  const driver = access.driverId === viewer;
  const active =
    access.status === BookingStatus.ACCEPTED &&
    !access.droppedOff &&
    !access.droppedOffAt &&
    !access.droppedOffConfirmedByPassenger &&
    [TripStatus.PENDING, TripStatus.ACTIVE].includes(access.tripStatus);
  const age =
    Date.now() - new Date(access.lastLocationUpdateAt ?? '').getTime();
  const live = active && age >= 0 && age <= 120_000;
  const passengerAge =
    Date.now() - new Date(access.passengerLastLocationUpdateAt ?? '').getTime();
  const passengerLive = active && passengerAge >= 0 && passengerAge <= 120_000;
  const contact = canContactBookingDriver(access.status, access.tripStatus);
  const tripInterruption = interruption(
    source.tripInterruptionRequest ?? trip.interruptionRequest,
    viewer,
    driver,
  );
  return {
    ...scalars(
      source,
      'id tripId passengerId numberOfSeats passengerOrigin passengerOriginReference passengerDestination passengerDestinationReference status paymentStatus paymentAmount proposedPricePerSeat grossPaymentAmount originalPaymentAmount firstTripSubsidyApplied passengerPaymentRate zwangaSubsidyAmount plannedDistanceMeters travelledDistanceMeters pricePerKilometer fareAdjustmentAmount fareAdjustedAt interruptionFareLocked paymentCurrency paymentMode mixedTokenAmount mixedTokenQuantity mixedPaymentAt paymentReference paymentTransactionId paidAt rejectionReason acceptedAt cancelledAt noShowDetectedAt noShowReason noShowDriverDistanceMeters boardingUncertainDetectedAt boardingUncertainReason boardingUncertainDriverDistanceMeters pickupDetectionMethod pickedUp pickedUpAt pickedUpConfirmedByPassenger pickedUpConfirmedAt droppedOff droppedOffAt droppedOffConfirmedByPassenger droppedOffConfirmedAt dropoffDetectionMethod driverPickupArrivedAt passengerDestinationApproachNotifiedAt cashReceivedAt cashReceivedAmount cashReceivedByDriverId tokenCashFallbackAt createdAt updatedAt',
    ),
    id: access.id,
    tripId: access.tripId,
    passengerId: access.passengerId,
    status: access.status,
    droppedOff: access.droppedOff,
    droppedOffAt: access.droppedOffAt,
    droppedOffConfirmedByPassenger: access.droppedOffConfirmedByPassenger,
    passengerOriginPoint: point(source.passengerOriginPoint),
    passengerDestinationPoint: point(source.passengerDestinationPoint),
    passengerCurrentLocation: passengerLive
      ? point(access.passengerCurrentLocation)
      : null,
    passengerLastLocationUpdateAt: passengerLive
      ? access.passengerLastLocationUpdateAt
      : null,
    passenger:
      asRecord(source.passenger).id === access.passengerId
        ? user(source.passenger, driver && contact)
        : null,
    arrivalPrompt: source.arrivalPrompt
      ? scalars(source.arrivalPrompt, 'id proposedAt expiresAt acceptedAt')
      : null,
    interruptionRequest: interruption(
      source.interruptionRequest,
      viewer,
      driver,
    ),
    tripInterruptionRequest: tripInterruption,
    trip: source.trip
      ? {
          ...scalars(
            trip,
            'id driverId vehicleId departureLocation departureReference arrivalLocation arrivalReference departureDate estimatedArrivalDate totalSeats availableSeats pricePerSeat isFree requiresPassengerKyc description status isPrivate tripRequestId startedAt completedAt createdAt updatedAt estimatedDurationSeconds previewArrivalDate arrivalEstimateSource paymentModesExplicit',
          ),
          id: access.tripId,
          driverId: access.driverId,
          status: access.tripStatus,
          departurePoint: point(trip.departurePoint),
          arrivalPoint: point(trip.arrivalPoint),
          acceptedPaymentModes: Array.isArray(trip.acceptedPaymentModes)
            ? trip.acceptedPaymentModes.filter((mode) =>
                ['cash', 'points', 'electronic'].includes(String(mode)),
              )
            : [],
          driver:
            asRecord(trip.driver).id === access.driverId
              ? user(trip.driver, driver || contact)
              : null,
          vehicle: trip.vehicle
            ? scalars(
                trip.vehicle,
                'id type brand model color photoUrl' +
                  (active || driver ? ' licensePlate' : ''),
              )
            : null,
          currentLocation: live ? point(access.currentLocation) : null,
          lastLocationUpdateAt: live ? access.lastLocationUpdateAt : null,
          bookings: [],
          interruptionRequest: tripInterruption,
        }
      : null,
  };
}
export function isBookingResponse(value: unknown): boolean {
  const record = asRecord(value);
  return (
    typeof record.id === 'string' &&
    typeof record.tripId === 'string' &&
    typeof record.passengerId === 'string' &&
    'paymentStatus' in record
  );
}
