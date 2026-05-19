-- Prevent a driver from having more than one active trip at a time.
-- Run this after resolving existing duplicate active trips.
DO $$
DECLARE
  duplicate_driver_count integer;
BEGIN
  SELECT count(*)
  INTO duplicate_driver_count
  FROM (
    SELECT "driverId"
    FROM trips
    WHERE status = 'ongoing'
    GROUP BY "driverId"
    HAVING count(*) > 1
  ) duplicate_drivers;

  IF duplicate_driver_count > 0 THEN
    RAISE EXCEPTION
      'Cannot create IDX_trips_one_active_per_driver: % driver(s) already have multiple ongoing trips. Run migrations/find-duplicate-active-driver-trips.sql, resolve the data, then rerun this migration.',
      duplicate_driver_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_trips_one_active_per_driver"
  ON trips ("driverId")
  WHERE status = 'ongoing';
