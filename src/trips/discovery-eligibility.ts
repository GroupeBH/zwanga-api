// Scalar PK lookups deliberately keep these checks correlated. PostGIS can
// underestimate a dense radius as one row: a decorrelated EXISTS then chooses
// a nested-loop sequential scan of users for every matching trip. A scalar
// boolean lookup remains a unique-key probe even with that row estimate.
// These expressions are internal SQL, never identifiers from a request.
export const discoveryAccountAvailableSql = `(SELECT account_owner."isActive" = true
  AND account_owner.status NOT IN ('inactive', 'suspended') FROM users account_owner
  WHERE account_owner.id = trip."driverId"::uuid) IS TRUE`;

// Do not cast the indexed primary key to text. NULL means a vehicle-less trip;
// a missing/disabled vehicle is not eligible (scalar NULL fails IS TRUE).
export const discoveryVehicleAvailableSql = `("trip"."vehicleId" IS NULL OR
  (SELECT v."isActive" FROM vehicles v WHERE v.id=trip."vehicleId"::uuid) IS TRUE)`;
