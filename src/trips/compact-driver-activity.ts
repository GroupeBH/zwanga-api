import type { SanitizedTrip } from './trips.service';

/** Opt-in wire format: share repeated driver profiles, retain every trip/booking. */
export function compactDriverActivity(trips: SanitizedTrip[]) {
  const drivers: Record<string, SanitizedTrip['driver']> = {};
  const items = trips.map(({ driver, ...trip }) => {
    if (driver) drivers[trip.driverId] = driver;
    return trip;
  });
  return { format: 'driver-activity-v1' as const, drivers, items };
}
