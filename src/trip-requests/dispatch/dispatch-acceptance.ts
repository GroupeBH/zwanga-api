import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DriverScheduleConflictException } from '../../common/driver-schedule-conflict';
import { assertDriverAccountCanOperate, assertDriverRequirements } from '../../users/driver-activation';
import type { User } from '../../users/entities/user.entity';
import { getVehicleMaxSeats, type VehicleType } from '../../vehicles/entities/vehicle.entity';
import type { TripRequest } from '../entities/trip-request.entity';
import { requestDriverProximitySql } from '../request-proximity';
import { requestAcceptsVehicle } from '../request-vehicle-types';
import { driverRequestConflictSql, findDriverRequestConflict } from './driver-schedule-policy';
import { hasUsableDriverLocation } from './driver-location-policy';

interface AcceptanceState extends Pick<User, 'role' | 'isActive' | 'status'> {
  identityApproved: boolean;
  hasVehicle: boolean;
  vehicleType: VehicleType | null;
  nearby: boolean;
  busy: boolean;
}

/** Caller holds request then invitation locks. Keep owner -> presence ordering.
 * Never merge a potentially waiting lock and the schedule/permission reads into
 * one statement: READ COMMITTED must see commits made while the lock was awaited.
 * No Redis/cache authorization, no geometry/entity hydration or network calls. */
export async function assertDispatchAcceptance(manager: EntityManager, request: TripRequest,
  offer: { driverId: string; vehicleId: string; seats: number; expiresAt: Date; phase?: string }) {
  // The caller's offer lock protects this phase; reject a consent/preparation
  // button before waiting for any further locks or performing eligibility SQL.
  if (request.sequentialDispatch && offer.phase !== 'driver')
    throw new ConflictException({ code: 'REQUEST_INVITATION_EXPIRED',
      message: 'Cette commande a été proposée à un autre conducteur.' });
  const driverId = offer.driverId;
  await manager.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [driverId]);
  const [presence] = await manager.query(`SELECT "vehicleId", "discoveryEnabled", "expiresAt"
    FROM driver_dispatch_presence WHERE "driverId"=$1 FOR UPDATE`, [driverId]);
  // These are the same policy predicates as the non-batched paths. Select only
  // what admission needs; read the latest KYC, not any previously approved one.
  const [state] = await manager.query<AcceptanceState[]>(`SELECT u.role, u."isActive", u.status,
    COALESCE((SELECT k.status='approved' FROM kyc_documents k WHERE k."userId"=u.id
      ORDER BY k."createdAt" DESC, k.id DESC LIMIT 1),false) AS "identityApproved",
    EXISTS (SELECT 1 FROM vehicles owned WHERE owned."ownerId"=u.id AND owned."isActive"=true) AS "hasVehicle",
    (SELECT v.type FROM vehicles v WHERE v.id=$3 AND v."ownerId"=u.id AND v."isActive"=true) AS "vehicleType",
    ${requestDriverProximitySql('$2::uuid', 'u.id')} AS nearby,
    ${driverRequestConflictSql('u.id', '$2::uuid')} AS busy
    FROM users u WHERE u.id=$1`, [driverId, request.id, offer.vehicleId]);
  // Recheck deadlines AFTER lock waits as well. A button held open by another
  // transaction must not resurrect an expired invitation or passenger decision.
  if (new Date(offer.expiresAt).getTime() <= Date.now() || request.departureDateMax.getTime() <= Date.now())
    throw new ConflictException('Cette proposition a expiré ou a déjà été traitée.');
  if (!state) throw new NotFoundException('Conducteur introuvable.');
  if (!state.nearby)
    throw new NotFoundException('Cette commande est hors de votre zone de prise en charge. Actualisez votre position.');
  if (state.busy) throw new DriverScheduleConflictException(await findDriverRequestConflict(manager, driverId, request.id));
  if (!hasUsableDriverLocation(presence) || presence.vehicleId !== offer.vehicleId)
    throw new ConflictException('Votre position ou votre véhicule ne sont plus valides. Rouvrez l’application pour actualiser votre position.');
  assertDriverAccountCanOperate(state);
  assertDriverRequirements(state);
  if (!state.vehicleType || !requestAcceptsVehicle(request, state.vehicleType) || offer.seats < request.numberOfSeats ||
      (getVehicleMaxSeats(state.vehicleType) ?? 20) < offer.seats)
    throw new ConflictException('Vous ou votre véhicule ne pouvez plus prendre en charge cette commande.');
}

/** Disjoint writes, one snapshot. Request/offer/owner/presence are already locked.
 * A single offer UPDATE handles winner and siblings, never two CTE updates of
 * the same row. The outbox is still inserted by the caller before COMMIT. */
export async function commitDispatchSelection(manager: EntityManager, requestId: string,
  offerId: string, driverId: string, vehicleId: string, selectedAt: Date, price: number) {
  await manager.query(`WITH selected AS (
    UPDATE trip_requests SET status='driver_selected', "selectedDriverId"=$3, "selectedVehicleId"=$4,
      "selectedPricePerSeat"=$6, "selectedDriverRequiresPassengerKyc"=false, "selectedAt"=$5,
      "driverPickupOverdueNotifiedAt"=NULL, "updatedAt"=CURRENT_TIMESTAMP WHERE id=$1 RETURNING id
  ), invitations AS (
    UPDATE trip_request_dispatch_offers SET status=CASE WHEN id=$2 THEN 'accepted' ELSE 'cancelled' END
      WHERE "requestId"=$1 AND status='pending' RETURNING id
  ) UPDATE driver_dispatch_presence SET "expiresAt"=now() WHERE "driverId"=$3`,
  [requestId, offerId, driverId, vehicleId, selectedAt, price]);
}
