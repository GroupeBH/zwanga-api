import { ConflictException } from '@nestjs/common';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { TripRequest } from './entities/trip-request.entity';
import {
  Vehicle,
  getVehicleMaxSeats,
} from '../vehicles/entities/vehicle.entity';
import { assertUnassignedRequest } from './request-edit-policy';

export function assertSharedTripAvailable(
  request: TripRequest,
  trip: Trip,
  vehicle: Vehicle | null,
  driverId: string,
  now = Date.now(),
): void {
  assertUnassignedRequest(request, now);
  if (
    request.passengerId === driverId ||
    trip.driverId !== driverId ||
    trip.status !== TripStatus.ACTIVE ||
    trip.destinationReachedAt ||
    !vehicle?.isActive ||
    vehicle.ownerId !== driverId ||
    trip.vehicleId !== vehicle.id ||
    vehicle.type !== request.vehicleType ||
    !trip.totalSeats ||
    trip.availableSeats < request.numberOfSeats ||
    trip.totalSeats > (getVehicleMaxSeats(vehicle.type) ?? 20) ||
    new Date(request.departureDateMax).getTime() <= now ||
    new Date(request.departureDateMin).getTime() > now + 10 * 60_000
  ) {
    throw new ConflictException(
      'Ce trajet en cours ne peut plus accueillir cette commande.',
    );
  }
  const price = trip.isFree ? 0 : Number(trip.pricePerSeat);
  if (
    !Number.isFinite(price) ||
    price < 0 ||
    request.maxPricePerSeat == null ||
    price > Number(request.maxPricePerSeat) ||
    (price > 0 &&
      trip.acceptedPaymentModes &&
      !trip.acceptedPaymentModes.includes(request.paymentMode))
  ) {
    throw new ConflictException(
      'Le tarif ou le mode de paiement du trajet ne correspond pas à cette commande.',
    );
  }
}
