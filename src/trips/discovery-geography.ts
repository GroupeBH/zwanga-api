/** Indexable branches equivalent to the display/ranking CASE, including NULL GPS. */
export const discoveryDepartureWithinSql = `(
  ((trip.status = :activeStatus AND trip."lastLocationUpdateAt" >= NOW() - INTERVAL '90 seconds'
      AND trip."currentLocation" IS NOT NULL) IS TRUE
    AND ST_DWithin(trip."currentLocation", ST_SetSRID(ST_MakePoint(:depLng, :depLat),4326)::geography,:depRadius))
  OR
  ((trip.status = :activeStatus AND trip."lastLocationUpdateAt" >= NOW() - INTERVAL '90 seconds'
      AND trip."currentLocation" IS NOT NULL) IS NOT TRUE
    AND ST_DWithin(trip."departurePoint", ST_SetSRID(ST_MakePoint(:depLng, :depLat),4326)::geography,:depRadius))
)`;
