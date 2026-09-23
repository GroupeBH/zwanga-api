import type { CacheService } from './services/cache.service';
import type { DirectionsDto, DirectionsResponse } from '../google-maps/dto/google-maps.dto';
import type { Trip } from '../trips/entities/trip.entity';

type Coordinate = { lat: number; lng: number };
type Summary = { seconds: number; savedAt: number };
const MAX_AGE_MS = 24 * 60 * 60_000;
const valid = (point?: Partial<Coordinate> | null): point is Coordinate =>
  typeof point?.lat === 'number' && typeof point.lng === 'number' && Number.isFinite(point.lat)
  && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
export function routePreviewKey(origin?: Partial<Coordinate>, destination?: Partial<Coordinate>) {
  if (!valid(origin) || !valid(destination)) return null;
  return `route-preview:v1:${origin.lat.toFixed(5)}:${origin.lng.toFixed(5)}:${destination.lat.toFixed(5)}:${destination.lng.toFixed(5)}`;
}

/** Reuse a route already calculated by the form/navigation; never call the provider from a list. */
export async function rememberRoutePreview(cache: CacheService, dto: DirectionsDto, result: DirectionsResponse) {
  if ((dto.mode && dto.mode !== 'driving') || dto.waypoints?.length || dto.avoid?.length) return;
  const key = routePreviewKey(dto.origin, dto.destination);
  const seconds = result.routes?.[0]?.legs?.reduce((sum, leg) => sum + Number(leg.duration || 0), 0);
  if (!key || !seconds || !Number.isFinite(seconds) || seconds <= 0) return;
  try { await cache.set(key, { seconds, savedAt: Date.now() }, MAX_AGE_MS); }
  catch { /* A cache failure must not fail navigation or payment estimation. */ }
}

export function approximateRouteSeconds(origin: Coordinate, destination: Coordinate) {
  const rad = Math.PI / 180;
  const lat = (destination.lat - origin.lat) * rad, lng = (destination.lng - origin.lng) * rad;
  const a = Math.sin(lat / 2) ** 2 + Math.cos(origin.lat * rad) * Math.cos(destination.lat * rad) * Math.sin(lng / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
  // Deliberately labelled approximate, not traffic-aware or a fare input.
  return Math.max(60, Math.round(km * 1.3 / 30 * 3600));
}

export async function getTripRoutePreview(cache: CacheService, trip: Trip) {
  const departure = new Date(trip.status !== 'upcoming' && trip.startedAt ? trip.startedAt : trip.departureDate).getTime();
  const savedArrival = trip.estimatedArrivalDate ? new Date(trip.estimatedArrivalDate).getTime() : NaN;
  let seconds: number | null = null;
  let source: 'trip_start' | 'route' | 'approximate' | 'unavailable' = 'unavailable';
  if (trip.status !== 'upcoming' && Number.isFinite(departure) && savedArrival > departure) {
    seconds = Math.round((savedArrival - departure) / 1000); source = 'trip_start';
  } else {
    const origin = { lng: trip.departurePoint?.coordinates?.[0], lat: trip.departurePoint?.coordinates?.[1] };
    const destination = { lng: trip.arrivalPoint?.coordinates?.[0], lat: trip.arrivalPoint?.coordinates?.[1] };
    const key = routePreviewKey(origin, destination);
    if (key && valid(origin) && valid(destination)) {
      try {
        const summary = await cache.get<Summary>(key);
        const age = Date.now() - Number(summary?.savedAt);
        if (summary && Number.isFinite(summary.seconds) && summary.seconds > 0 && age >= 0 && age < MAX_AGE_MS) {
          seconds = summary.seconds; source = 'route';
        }
      } catch { /* Lists remain available without the route cache. */ }
      if (!seconds) { seconds = approximateRouteSeconds(origin, destination); source = 'approximate'; }
    }
  }
  return {
    estimatedDurationSeconds: seconds,
    arrivalEstimateSource: source,
    // This presentation field does not overwrite the persisted trip deadline.
    previewArrivalDate: seconds && Number.isFinite(departure) ? new Date(departure + seconds * 1000).toISOString() : null,
  };
}

export async function attachBookingRoutePreviews<T extends { trip?: Trip }>(cache: CacheService, bookings: T[]) {
  const pending = new Map<string, ReturnType<typeof getTripRoutePreview>>();
  for (const booking of bookings) {
    if (!booking.trip) continue;
    if (!pending.has(booking.trip.id)) pending.set(booking.trip.id, getTripRoutePreview(cache, booking.trip));
  }
  await Promise.all(bookings.map(async booking => {
    if (booking.trip) Object.assign(booking.trip, await pending.get(booking.trip.id));
  }));
}
