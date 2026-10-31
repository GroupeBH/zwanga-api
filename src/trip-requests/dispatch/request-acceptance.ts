import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager, In, QueryFailedError } from 'typeorm';
import { TripRequest, TripRequestStatus } from '../entities/trip-request.entity';
import { Trip, TripStatus } from '../../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../../bookings/entities/booking.entity';
import { DriverOffer, DriverOfferStatus } from '../entities/driver-offer.entity';
import { assertRequestSnapshot, assertUnassignedRequest } from '../request-edit-policy';
import { assertSequentialInvitation } from './sequential-policy';
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';
import { claimInAppRequest } from './claim-in-app-request';

export const ACCEPTANCE_LEASE_MS = 120_000;
export const PASSENGER_DECISION_MS = 120_000;

/** Caller holds the request lock; an alternative offer counts as a driver response. */
export async function startPassengerDecision(manager: EntityManager, request: TripRequest, driverId: string) {
  if (!request.sequentialDispatch) return;
  await assertSequentialInvitation(manager, request, driverId);
  await manager.query(`UPDATE trip_request_dispatch_offers SET phase='passenger',
    "expiresAt"=LEAST(clock_timestamp()+$4*interval '1 millisecond',$3::timestamptz)
    WHERE "requestId"=$1 AND "driverId"=$2 AND status='pending'`,
    [request.id, driverId, request.departureDateMax, PASSENGER_DECISION_MS]);
  await silenceRequestInvitation(manager, request.id, driverId);
}

/** A failed preparation releases only its own claim, never another worker's acceptance. */
export async function releaseRequestAcceptance(manager: EntityManager, requestId: string, driverId: string, token?: string) {
  if (!token) return;
  await manager.transaction(async tx => {
    const request = await tx.findOne(TripRequest, { where: { id: requestId }, lock: { mode: 'pessimistic_write' } });
    if (!request || request.selectedDriverId || request.tripId) return;
    await tx.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=clock_timestamp()
      WHERE "requestId"=$1 AND "driverId"=$2 AND "acceptanceToken"=$3
        AND status='pending' AND phase='accepting'`, [requestId, driverId, token]);
  });
}

/** Fence slow preparation before routing/geocoding; the token never comes from HTTP. */
export async function claimRequestAcceptance(manager: EntityManager, snapshot: TripRequest, driverId: string,
  vehicle?: { vehicleId: string; seats: number }) {
  if (!snapshot.sequentialDispatch) return undefined;
  return manager.transaction(async tx => {
    const request = await tx.findOne(TripRequest, { where: { id: snapshot.id }, lock: { mode: 'pessimistic_write' } });
    assertRequestSnapshot(request, snapshot); assertUnassignedRequest(request!);
    const token = randomUUID();
    await claimInAppRequest(tx, request!, driverId, token, ACCEPTANCE_LEASE_MS, vehicle);
    await silenceRequestInvitation(tx, snapshot.id);
    return token;
  }).catch((error: unknown) => {
    if (error instanceof QueryFailedError && 'constraint' in error.driverError &&
        error.driverError.constraint === 'dispatch_one_pending_response_idx')
      throw new ConflictException('Une autre réponse est en cours. Terminez-la avant de réessayer.');
    throw error;
  });
}

export async function silenceRequestInvitation(manager: EntityManager, requestId: string, driverId?: string) {
  await manager.query(`UPDATE notifications SET "isActive"=false WHERE "isActive"=true
    AND data->>'tripRequestId'=$1::text AND ($2::uuid IS NULL OR "userId"=$2)
    AND data->>'type' IN ('trip_request_nearby','driver_dispatch_offer','trip_request','new_trip_request')`, [requestId, driverId ?? null]);
}

/** Request then trip locks are held by the caller. Booking, seats and selection commit together. */
export async function completeRequestAcceptance(manager: EntityManager, request: TripRequest, trip: Trip) {
  if (![TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED, TripRequestStatus.DRIVER_SELECTED].includes(request.status) ||
      (request.selectedDriverId && request.selectedDriverId !== trip.driverId) || (request.tripId && request.tripId !== trip.id))
    throw new ConflictException('Cette commande a changé. Actualisez ses détails.');
  const booking = await manager.findOne(Booking, { where: { tripId: trip.id, passengerId: request.passengerId,
    status: In([BookingStatus.ACCEPTED, BookingStatus.COMPLETED]) } });
  if (!booking) throw new ConflictException('La réservation doit être confirmée avant le trajet.');
  const selectedAt = request.selectedAt ?? new Date();
  await manager.update(TripRequest, request.id, { status: TripRequestStatus.DRIVER_SELECTED,
    selectedDriverId: trip.driverId, selectedVehicleId: trip.vehicleId,
    selectedPricePerSeat: trip.pricePerSeat, selectedDriverRequiresPassengerKyc: trip.requiresPassengerKyc,
    selectedAt, tripId: trip.id, driverPickupOverdueNotifiedAt: null });
  await manager.update(TripRequest, request.id, { targetDriverPriorityUntil: null });
  await manager.query(`UPDATE trip_request_dispatch_offers SET status=CASE WHEN "driverId"=$2 THEN 'accepted' ELSE 'cancelled' END
    WHERE "requestId"=$1 AND status='pending'`, [request.id, trip.driverId]);
  await manager.update(DriverOffer, { tripRequestId: request.id, status: DriverOfferStatus.PENDING }, { status: DriverOfferStatus.REJECTED });
  await silenceRequestInvitation(manager, request.id);
  await enqueueTransactionalNotification(manager, { eventKey: `request-accepted:${request.id}:${trip.id}`,
    userId: request.passengerId, title: 'Commande acceptée',
    body: 'Un conducteur a accepté votre commande. Ouvrez-la pour voir les détails.',
    data: { type: 'trip_request_accepted', tripRequestId: request.id, tripId: trip.id, driverId: trip.driverId,
      requiresPassengerKyc: trip.requiresPassengerKyc, selectedAt: selectedAt.toISOString() } });
}

export type AcceptanceRecovery = { wait: number } | { complete: true } | { bookingId: string; driverId: string };

/** Recover old multi-transaction acceptances too. Never discard a committed reservation. */
export async function recoverRequestAcceptance(manager: EntityManager, request: TripRequest): Promise<AcceptanceRecovery | null> {
  if (request.selectedDriverId || request.tripId) return null;
  const trip = await manager.findOne(Trip, { where: { tripRequestId: request.id, isPrivate: true,
    status: In([TripStatus.PENDING, TripStatus.ACTIVE, TripStatus.COMPLETED]) }, lock: { mode: 'pessimistic_write' } });
  if (!trip) return null;
  const bookings = await manager.find(Booking, { where: { tripId: trip.id } });
  if (![TripRequestStatus.PENDING, TripRequestStatus.OFFERS_RECEIVED].includes(request.status)) {
    // Cancellation can race a crash after trip insertion but before the atomic booking.
    if (!bookings.length && trip.status === TripStatus.PENDING) await manager.update(Trip, trip.id, { status: TripStatus.CANCELLED });
    return null;
  }
  const accepted = bookings.find(b => b.passengerId === request.passengerId &&
    [BookingStatus.ACCEPTED, BookingStatus.COMPLETED].includes(b.status));
  if (accepted) { await completeRequestAcceptance(manager, request, trip); return { complete: true }; }
  const [invitation] = await manager.query(`SELECT phase,"expiresAt" FROM trip_request_dispatch_offers
    WHERE "requestId"=$1 AND "driverId"=$2 AND status='pending'`, [request.id, trip.driverId]);
  const until = invitation?.phase === 'accepting' ? new Date(invitation.expiresAt).getTime()
    : new Date(trip.createdAt).getTime() + ACCEPTANCE_LEASE_MS;
  if (until > Date.now()) return { wait: until };
  const pending = bookings.find(b => b.passengerId === request.passengerId && b.status === BookingStatus.PENDING);
  if (pending) {
    // Lease the recovery attempt across workers, including a crash during acceptBooking.
    await manager.query(`UPDATE trip_request_dispatch_offers SET phase='accepting',
      "expiresAt"=clock_timestamp()+interval '30 seconds' WHERE "requestId"=$1 AND "driverId"=$2 AND status='pending'`, [request.id, trip.driverId]);
    return { bookingId: pending.id, driverId: trip.driverId };
  }
  if (!bookings.length && trip.status === TripStatus.PENDING) {
    await manager.update(Trip, trip.id, { status: TripStatus.CANCELLED });
    await manager.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=clock_timestamp()
      WHERE "requestId"=$1 AND "driverId"=$2 AND status='pending'`, [request.id, trip.driverId]);
    return null;
  }
  // Unusual legacy paid/cancelled states require existing booking recovery, never silent deletion.
  return { wait: Date.now() + 30_000 };
}
