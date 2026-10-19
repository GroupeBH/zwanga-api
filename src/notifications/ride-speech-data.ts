/** Optional, bounded, scalar push metadata. No identity, coordinates or free-form message. */
export function rideSpeechData(ride: {
  departure?: string | null; arrival?: string | null; seats?: number; departureAt?: Date;
}): Record<string, string> {
  const data: Record<string, string> = { rideSpeechVersion: '1' };
  const label = (value?: string | null) => typeof value === 'string'
    ? value.slice(0, 240).replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N} ,.'’/()-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const departure = label(ride.departure); const arrival = label(ride.arrival);
  if (departure) data.rideDeparture = departure;
  if (arrival) data.rideArrival = arrival;
  if (Number.isInteger(ride.seats) && ride.seats! > 0 && ride.seats! < 100) data.rideSeats = String(ride.seats);
  if (ride.departureAt instanceof Date && Number.isFinite(ride.departureAt.getTime())) data.rideDepartureAt = ride.departureAt.toISOString();
  return data;
}
