import { ForbiddenException } from '@nestjs/common';

export type RideConfirmationMode = 'driver_only' | 'shared';

/** Use the persisted trip origin, never a flag supplied by the caller. GPS is unchanged. */
export function rideConfirmationMode(trip: {
  tripRequestId?: string | null;
}): RideConfirmationMode {
  return trip.tripRequestId ? 'driver_only' : 'shared';
}

export function assertPassengerCanConfirmRide(trip: {
  tripRequestId?: string | null;
}) {
  if (rideConfirmationMode(trip) === 'driver_only') {
    throw new ForbiddenException({
      code: 'RIDE_DRIVER_CONFIRMATION_REQUIRED',
      message:
        'Pour un trajet issu d’une demande, seul le conducteur peut confirmer manuellement l’embarquement ou l’arrivée. La détection automatique reste active.',
    });
  }
}
