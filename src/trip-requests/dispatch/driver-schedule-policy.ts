import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

// A departure window is not an arrival time. Until a reliable arrival estimate
// exists, reserve two hours after its latest departure, plus a 30-minute transfer.
// Internal SQL expressions only: never interpolate HTTP input into these helpers.
export const DRIVER_TRANSFER_MINUTES = 30;
export const DRIVER_UNKNOWN_DURATION_HOURS = 2;
const endOf = (start: string, estimate?: string) =>
  estimate
    ? `CASE WHEN ${estimate} > ${start} THEN ${estimate} ELSE ${start} + interval '${DRIVER_UNKNOWN_DURATION_HOURS} hours' END`
    : `${start} + interval '${DRIVER_UNKNOWN_DURATION_HOURS} hours'`;
const overlaps = (
  start: string,
  end: string,
  wantedStart: string,
  wantedEnd: string,
) =>
  `(${start} < ${wantedEnd} + interval '${DRIVER_TRANSFER_MINUTES} minutes'
    AND ${end} + interval '${DRIVER_TRANSFER_MINUTES} minutes' > ${wantedStart})`;

export function driverScheduleConflictSql(
  driver: string,
  start: string,
  end: string,
  exceptRequest = 'NULL::uuid',
  exceptTrip = 'NULL::uuid',
  requestsOnly = false,
): string {
  return `(EXISTS (SELECT 1 FROM trips busy_trip WHERE busy_trip."driverId" = ${driver}
    AND (${exceptTrip} IS NULL OR busy_trip.id <> ${exceptTrip})
    AND (${exceptRequest} IS NULL OR busy_trip."tripRequestId" IS DISTINCT FROM (${exceptRequest})::text)
    ${requestsOnly ? 'AND (busy_trip."isPrivate" = true OR busy_trip."tripRequestId" IS NOT NULL)' : ''}
    AND (busy_trip.status = 'ongoing' OR (busy_trip.status = 'upcoming'
      AND ${overlaps('busy_trip."departureDate"', endOf('busy_trip."departureDate"', 'busy_trip."estimatedArrivalDate"'), start, end)})))
    OR EXISTS (SELECT 1 FROM trip_requests assigned WHERE assigned."selectedDriverId" = ${driver}
      AND assigned.status = 'driver_selected' AND (${exceptRequest} IS NULL OR assigned.id <> ${exceptRequest})
      AND NOT EXISTS (SELECT 1 FROM trips linked WHERE linked."driverId" = assigned."selectedDriverId"
        AND (linked."tripRequestId" = assigned.id::text
        OR linked.id = CASE WHEN assigned."tripId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN assigned."tripId"::uuid ELSE NULL END))
      AND ${overlaps('assigned."departureDateMin"', endOf('assigned."departureDateMax"'), start, end)})
    OR EXISTS (SELECT 1 FROM trip_request_dispatch_offers preparation
      JOIN trip_requests preparing ON preparing.id = preparation."requestId"
      WHERE preparation."driverId" = ${driver} AND preparation.status = 'pending'
        AND preparation.phase IN ('accepting','passenger')
        AND (${exceptRequest} IS NULL OR preparing.id <> ${exceptRequest})
        AND preparing.status IN ('pending','offers_received','driver_selected')
        AND ${overlaps('preparing."departureDateMin"', endOf('preparing."departureDateMax"'), start, end)}))`;
}

export function driverRequestConflictSql(
  driver: string,
  request: string,
): string {
  return `EXISTS (SELECT 1 FROM trip_requests wanted WHERE wanted.id = ${request}
    AND ${driverScheduleConflictSql(
      driver,
      'GREATEST(wanted."departureDateMin", now())',
      endOf('GREATEST(wanted."departureDateMax", now())'),
      request,
    )})`;
}

/** Caller holds its request lock; serialize competing acceptances/publications
 * on the owner before re-reading schedules in a fresh READ COMMITTED snapshot. */
export async function assertDriverRequestSchedule(
  manager: EntityManager,
  driverId: string,
  requestId: string,
) {
  await manager.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [
    driverId,
  ]);
  const [result] = await manager.query<{ busy: boolean }[]>(
    `SELECT ${driverRequestConflictSql('$1::uuid', '$2::uuid')} AS busy`,
    [driverId, requestId],
  );
  if (!result || result.busy)
    throw new ConflictException({
      code: 'DRIVER_SCHEDULE_CONFLICT',
      message:
        'Vous avez déjà une course à cette heure. Choisissez une demande à un autre horaire.',
    });
}

/** Public-trip owner is already locked. Preserve public/public publication
 * behavior, but never overwrite a private request reservation concurrently. */
export async function assertPublicationRequestSchedule(
  manager: EntityManager,
  trip: {
    driverId: string;
    id?: string;
    departureDate: Date;
    estimatedArrivalDate?: Date | null;
  },
) {
  const [result] = await manager.query<{ busy: boolean }[]>(
    `SELECT ${driverScheduleConflictSql(
      '$1::uuid',
      '$2::timestamp',
      endOf('$2::timestamp', '$3::timestamp'),
      'NULL::uuid',
      '$4::uuid',
      true,
    )} AS busy`,
    [
      trip.driverId,
      trip.departureDate,
      trip.estimatedArrivalDate ?? null,
      trip.id ?? null,
    ],
  );
  if (!result || result.busy)
    throw new ConflictException({
      code: 'DRIVER_SCHEDULE_CONFLICT',
      message:
        'Une commande est déjà prévue à cette heure. Choisissez un autre horaire.',
    });
}

/** The owner and edited trip are already locked. Exclude the trip and its own
 * request, but protect all engagements when editing a private/request course. */
export async function assertTripUpdateSchedule(
  manager: EntityManager,
  trip: {
    id: string;
    driverId: string;
    departureDate: Date;
    estimatedArrivalDate?: Date | null;
    tripRequestId?: string | null;
    isPrivate?: boolean;
  },
) {
  const requestId =
    trip.tripRequestId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trip.tripRequestId,
    )
      ? trip.tripRequestId
      : null;
  const [result] = await manager.query<{ busy: boolean }[]>(
    `SELECT ${driverScheduleConflictSql(
      '$1::uuid',
      '$2::timestamp',
      endOf('$2::timestamp', '$3::timestamp'),
      '$5::uuid',
      '$4::uuid',
      !trip.isPrivate && !trip.tripRequestId,
    )} AS busy`,
    [
      trip.driverId,
      trip.departureDate,
      trip.estimatedArrivalDate ?? null,
      trip.id,
      requestId,
    ],
  );
  if (!result || result.busy)
    throw new ConflictException({
      code: 'DRIVER_SCHEDULE_CONFLICT',
      message:
        'Vous avez déjà une course à cette heure. Choisissez un autre horaire.',
    });
}
