-- Shows drivers that currently have more than one ongoing trip.
-- Resolve these rows before creating IDX_trips_one_active_per_driver.
SELECT
  "driverId",
  count(*) AS active_trip_count,
  array_agg(id ORDER BY COALESCE("startedAt", "updatedAt", "createdAt") DESC) AS trip_ids
FROM trips
WHERE status = 'ongoing'
GROUP BY "driverId"
HAVING count(*) > 1
ORDER BY active_trip_count DESC, "driverId";

-- Detail view for manual cleanup decisions.
SELECT
  id,
  "driverId",
  status,
  "departureLocation",
  "arrivalLocation",
  "departureDate",
  "startedAt",
  "updatedAt",
  "createdAt"
FROM trips
WHERE "driverId" IN (
  SELECT "driverId"
  FROM trips
  WHERE status = 'ongoing'
  GROUP BY "driverId"
  HAVING count(*) > 1
)
AND status = 'ongoing'
ORDER BY "driverId", COALESCE("startedAt", "updatedAt", "createdAt") DESC;
