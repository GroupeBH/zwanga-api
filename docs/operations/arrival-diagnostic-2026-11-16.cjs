'use strict';
// One-shot, read-only production diagnostic. No application bootstrap or writes.
process.env.TZ = 'UTC';
const { Client } = require('pg');
const { readFileSync, existsSync } = require('node:fs');
const emit = (kind, data) => console.log('ARRIVAL_AUDIT_20261116 ' + JSON.stringify({ kind, ...data }));
const deadline = setTimeout(() => { emit('failure', { code: 'DEADLINE' }); process.exit(2); }, 45000);
let client;
let stage = 'config';
(async () => {
  const env = process.env;
  let connection;
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    connection = { connectionString: url.toString() };
  } else {
    if (!env.DATABASE_HOST || !env.DATABASE_USER || !env.DATABASE_NAME) throw new Error();
    connection = { host: env.DATABASE_HOST, port: Number(env.DATABASE_PORT || 5432), user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD, database: env.DATABASE_NAME };
  }
  client = new Client({ ...connection,
    ssl: { rejectUnauthorized: true, ca: readFileSync(env.DATABASE_SSL_CA_FILE || env.NODE_EXTRA_CA_CERTS ||
      '/usr/local/share/ca-certificates/aws-rds-global-bundle.crt', 'utf8') },
    application_name: 'arrival-readonly-20261116', connectionTimeoutMillis: 5000,
    statement_timeout: 8000, query_timeout: 10000, lock_timeout: 1000,
    idle_in_transaction_session_timeout: 15000, options: '-c default_transaction_read_only=on' });
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [mode] } = await client.query("SELECT current_setting('transaction_read_only') AS read_only");
  if (mode.read_only !== 'on') throw new Error();
  emit('mode', mode);
  stage = 'driver';
  const { rows: users } = await client.query(`SELECT id,
    (lower(coalesce("firstName",'') || ' ' || coalesce("lastName",'')) LIKE '%bosuku%') AS name_matches,
    status::text, "isActive" AS active FROM public.users
    WHERE right(regexp_replace(phone,'[^0-9]','','g'),4)=$1 LIMIT 11`, ['9710']);
  emit('candidates', { count: users.length, matchingNames: users.filter(u => u.name_matches).length });
  const matches = users.filter(u => u.name_matches);
  if (users.length > 10 || matches.length !== 1) throw Object.assign(new Error(), { code: 'AMBIGUOUS_DRIVER' });
  stage = 'trips';
  const { rows: trips } = await client.query(`SELECT t.id, t.status::text,
    t."createdAt", t."departureDate", t."startedAt", t."completedAt", t."updatedAt",
    t."lastLocationUpdateAt", t."destinationApproachNotifiedAt", t."destinationReachedAt",
    round(ST_Distance(t."currentLocation",t."arrivalPoint")) AS driver_to_arrival_m,
    round(extract(epoch FROM (t."completedAt"-t."lastLocationUpdateAt"))) AS gps_age_at_completion_seconds,
    t."tripRequestId" IS NOT NULL AS from_request
    FROM public.trips t WHERE t."driverId"=$1
    AND (t."departureDate" BETWEEN $2::timestamp AND $3::timestamp
      OR t."startedAt" BETWEEN $2::timestamp AND $3::timestamp
      OR t."completedAt" BETWEEN $2::timestamp AND $3::timestamp)
    ORDER BY t."departureDate" LIMIT 21`, [matches[0].id,'2026-11-14T23:00:00','2026-11-15T23:00:00']);
  emit('trip_count', { count: trips.length });
  if (trips.length > 20) throw Object.assign(new Error(), { code: 'TOO_MANY_TRIPS' });
  for (const trip of trips) emit('trip', trip);
  stage = 'bookings';
  if (trips.length) {
    const { rows } = await client.query(`SELECT b.id, b."tripId", b.status::text,
      b."createdAt", b."updatedAt", b."paymentMode", b."paymentStatus",
      b."pickedUp", b."pickedUpAt", b."pickedUpConfirmedByPassenger", b."pickedUpConfirmedAt",
      b."droppedOff", b."droppedOffAt", b."droppedOffConfirmedByPassenger", b."droppedOffConfirmedAt",
      b."pickupDetectionMethod", b."dropoffDetectionMethod", b."passengerLastLocationUpdateAt",
      b."passengerDestinationApproachNotifiedAt", b."noShowDetectedAt", b."boardingUncertainDetectedAt",
      round(ST_Distance(t."currentLocation",coalesce(b."passengerDestinationPoint",t."arrivalPoint"))) AS driver_to_dropoff_m,
      round(ST_Distance(b."passengerCurrentLocation",coalesce(b."passengerDestinationPoint",t."arrivalPoint"))) AS passenger_to_dropoff_m,
      round(ST_Distance(b."passengerDestinationPoint",t."arrivalPoint")) AS destinations_difference_m,
      (b."rideDeclarations" ? 'pickup') AS has_pickup_declaration,
      (b."rideDeclarations" ? 'dropoff') AS has_dropoff_declaration
      FROM public.bookings b JOIN public.trips t ON t.id::text=b."tripId"::text
      WHERE b."tripId"::text=ANY($1::text[]) ORDER BY b."createdAt" LIMIT 51`, [trips.map(t=>t.id)]);
    rows.forEach(row => emit('booking', row));
  }
  await client.query('ROLLBACK');
  await client.end(); client = undefined;
  stage = 'deployed_code';
  const file = ['dist/bookings/bookings.service.js','dist/src/bookings/bookings.service.js'].find(existsSync);
  if (file) {
    const source = readFileSync(file,'utf8');
    emit('deployed_rules', { constants: source.split('\n').filter(line => /this\.(AUTO_TRIP_DESTINATION_\w+|AUTO_DROPOFF_DIRECT_CONFIRM_THRESHOLD_METERS)\s*=/.test(line)).map(s=>s.trim()),
      requiresReachedBeforePassed: source.includes('passedDestinationAfterReaching') && source.includes('trip.destinationReachedAt'),
      freshLocationCheck: source.includes('isFreshLocationUpdate(trip.lastLocationUpdateAt'),
      passengerFreshPairForSeparation: source.includes('!this.hasFreshGpsPair(booking, now)') });
  }
  emit('complete', { writes: false });
})().catch(async error => {
  emit('failure', { stage, code: typeof error?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code) ? error.code : 'FAILED' });
  if (client) { try { await client.query('ROLLBACK'); } catch {} try { await client.end(); } catch {} }
  process.exitCode=1;
}).finally(()=>clearTimeout(deadline));
