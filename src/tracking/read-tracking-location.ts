import type { Repository } from 'typeorm';
import type { Trip } from '../trips/entities/trip.entity';
import type { Booking } from '../bookings/entities/booking.entity';
import { FreshReadBatch } from '../common/fresh-read-batch';
import { copySqlProjection } from '../common/utils/copy-sql-projection';

type TripReader = Pick<Repository<Trip>, 'query'>;
type BookingReader = Pick<Repository<Booking>, 'query'>;
const driverReads = new WeakMap<TripReader, FreshReadBatch<string, Trip | null>>();
const passengerReads = new WeakMap<BookingReader, FreshReadBatch<{ bookingId: string; passengerId: string }, Booking | null>>();

// Fresh, parameterized reads on every GPS (and every failed conditional write).
// Avoid rebuilding/hydrating ORM joins in this hot path; these partial objects
// must never be saved or used for payment/settlement or cached authorization.
export async function readDriverTrackingTrip(db: Pick<Repository<Trip>, 'query'>, tripId: string): Promise<Trip | null> {
  let reader = driverReads.get(db);
  if (!reader) {
    reader = new FreshReadBatch(async ids => {
      const rows: Trip[] = await db.query(`SELECT t.id, t."driverId", t."status", t."lastLocationUpdateAt",
    ST_AsGeoJSON(t."currentLocation")::json AS "currentLocation",
    ST_AsGeoJSON(t."departurePoint")::json AS "departurePoint",
    ST_AsGeoJSON(t."arrivalPoint")::json AS "arrivalPoint"
    FROM trips t WHERE t.id = ANY($1::uuid[])`, [[...new Set(ids)]]);
      const byId = new Map(rows.map(row => [row.id, row]));
      // Services mutate their projection after a successful write. Never share
      // mutable objects between concurrent callers, including duplicate keys.
      return ids.map(id => copySqlProjection(byId.get(id) ?? null));
    });
    driverReads.set(db, reader);
  }
  return reader.load(tripId.toLowerCase());
}

export async function readPassengerTrackingBooking(db: Pick<Repository<Booking>, 'query'>,
  bookingId: string, passengerId: string): Promise<Booking | null> {
  let reader = passengerReads.get(db);
  if (!reader) {
    reader = new FreshReadBatch(async keys => {
      const rows: Booking[] = await db.query(`SELECT b.id, b."tripId", b."passengerId", b.status,
    ST_AsGeoJSON(b."passengerCurrentLocation")::json AS "passengerCurrentLocation",
    b."passengerLastLocationUpdateAt",
    ST_AsGeoJSON(b."passengerDestinationPoint")::json AS "passengerDestinationPoint",
    b."destinationProximityNotified", b."pickedUp", b."pickedUpAt",
    b."pickedUpConfirmedByPassenger", b."pickedUpConfirmedAt", b."droppedOff", b."droppedOffAt",
    b."droppedOffConfirmedByPassenger", b."droppedOffConfirmedAt",
    CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'status', t.status,
      'departurePoint', ST_AsGeoJSON(t."departurePoint")::json,
      'arrivalPoint', ST_AsGeoJSON(t."arrivalPoint")::json) END AS trip
    FROM bookings b LEFT JOIN trips t ON t.id = b."tripId"
    WHERE (b.id, b."passengerId") IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))`,
      [keys.map(key => key.bookingId), keys.map(key => key.passengerId)]);
      const byOwner = new Map(rows.map(row => [`${row.id}:${row.passengerId}`, row]));
      // Pair IDs, not two independent ANY predicates: another owner's booking
      // in the same batch must never satisfy this caller's authorization read.
      return keys.map(key => copySqlProjection(byOwner.get(`${key.bookingId}:${key.passengerId}`) ?? null));
    });
    passengerReads.set(db, reader);
  }
  return reader.load({ bookingId: bookingId.toLowerCase(), passengerId: passengerId.toLowerCase() });
}
