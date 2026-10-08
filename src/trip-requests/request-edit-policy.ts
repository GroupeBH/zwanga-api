import { ConflictException } from '@nestjs/common';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';

export const UNACCEPTED_REQUEST_EXPIRATION_MS = 3 * 60 * 60 * 1000;
export const ACCEPTED_REQUEST_EXPIRATION_MS = 2 * 60 * 60 * 1000;

/** Compare the Date precision returned by pg, then recheck state under the row lock. */
export function assertRequestSnapshot(
  current: TripRequest | null,
  snapshot: TripRequest,
) {
  if (
    !current ||
    current.status !== snapshot.status ||
    current.selectedDriverId !== snapshot.selectedDriverId ||
    current.tripId !== snapshot.tripId ||
    new Date(current.updatedAt).getTime() !==
      new Date(snapshot.updatedAt).getTime()
  ) {
    throw new ConflictException(
      'La demande a changé. Actualisez-la avant de réessayer.',
    );
  }
}

export function assertUnassignedRequest(
  request: TripRequest,
  now = Date.now(),
  allowExpired = false,
) {
  const states = [
    TripRequestStatus.PENDING,
    TripRequestStatus.OFFERS_RECEIVED,
    ...(allowExpired ? [TripRequestStatus.EXPIRED] : []),
  ];
  if (
    !states.includes(request.status) ||
    request.selectedDriverId ||
    request.tripId ||
    (!allowExpired &&
      new Date(request.departureDateMax).getTime() +
        UNACCEPTED_REQUEST_EXPIRATION_MS <=
        now)
  ) {
    throw new ConflictException(
      'Cette demande est déjà prise en charge, annulée ou expirée.',
    );
  }
}
