'use strict';

const { randomUUID, createHash } = require('node:crypto');

// This module is called only on a newly initialized disposable cluster.
// Entity synchronization is not a migration/deployment test: report that boundary.
async function seed(db, load, p, secret) {
  if (db.options.host !== '127.0.0.1' || db.options.username !== 'audit_test' || db.options.database !== 'postgres')
    throw new Error('Fixtures require a newly provisioned loopback test database');
  const [existing] = await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
  if (existing.n !== 0) throw new Error('Fixtures refuse any existing application tables');
  const { typeOrmEntities } = load('database/entities');
  db.setOptions({ entities: typeOrmEntities });
  await db.buildMetadatas();
  await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
  await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await db.synchronize();
  await db.query('ALTER TABLE trip_requests DROP COLUMN "immediateDispatch", DROP COLUMN "sequentialDispatch"');
  await db.query('ALTER TABLE notifications DROP COLUMN "pushAttempts", DROP COLUMN "pushRetryAt", DROP COLUMN "pushPermanentFailure"');
  const migrations = [
    '1780000048000-AddDriverDispatch', '1780000074000-BroadcastDriverRequests',
    '1780000076000-RetainDriverLastLocation', '1780000087000-NearbyRequestRingingCooldown',
    '1780000088000-DispatchDeliveryResilience', '1780000093000-RideNotificationReceipts',
    '1780000094000-RideDeliveryRecovery', '1780000095000-RememberDriverRequestRefusals',
    '1780000097000-SequentialRequestQueue', '1780000098000-RequestResponsePhases',
    '1780000106000-AlertDeliveryReliability',
    '1780000110000-ReceiptResponseWindow', '1780000123000-FourDriverDispatchWaves',
    '1780000135000-PerformanceWorkQueues',
  ];
  for (const file of migrations) {
    const [stamp, name] = file.split('-');
    const runner = db.createQueryRunner();
    try {
      await runner.startTransaction();
      await new (load(`database/migrations/${file}`)[name + stamp])().up(runner);
      await runner.commitTransaction();
    } catch (e) { await runner.rollbackTransaction(); throw e; }
    finally { await runner.release(); }
  }
  await db.query('CREATE INDEX "IDX_kyc_welcome_latest" ON kyc_documents ("userId", "createdAt" DESC, id DESC)');
  const { JwtService } = require('@nestjs/jwt');
  const jwt = new JwtService();
  const { tokenFingerprint } = load('auth/token-fingerprint');
  const syntheticId = require('./scenario-inputs.cjs').fixtureIds(p.fixtureSeed);
  const users = [], vehicles = [], identities = [], trips = [], bookings = [];
  const point = longitude => ({ type: 'Point', coordinates: [longitude, -4.3] });
  function account(driver) {
    const id = syntheticId(), role = driver ? 'driver' : 'passenger';
    const email = `${id}@example.invalid`, fcmToken = `synthetic-${id}`;
    const token = jwt.sign({ sub: id, email, role }, { secret, expiresIn: '3h' });
    users.push({ id, email, firstName: 'Synthetic', lastName: 'Journey', role, isDriver: driver,
      isActive: true, status: 'active', isPhoneVerified: true, accessToken: tokenFingerprint(token), fcmToken });
    const a = { id, token };
    if (driver) {
      a.vehicleId = syntheticId(); a.fcmToken = fcmToken;
      vehicles.push({ id: a.vehicleId, ownerId: id, brand: 'Synthetic', model: 'Fixture', color: 'white',
        licensePlate: `TEST-${id}`, type: 'car', isActive: true });
      identities.push({ userId: id, status: 'approved' });
    }
    return a;
  }
  const journeys = Array.from({ length: p.maxTrips }, () => {
    const driver = account(true), passenger = account(false), tripId = syntheticId(), bookingId = syntheticId();
    trips.push({ id: tripId, driverId: driver.id, vehicleId: driver.vehicleId, status: 'ongoing',
      departureDate: new Date(), startedAt: new Date(), departureLocation: 'Synthetic pickup',
      arrivalLocation: 'Synthetic dropoff', departurePoint: point(15.31), arrivalPoint: point(15.318),
      totalSeats: 4, availableSeats: 3, pricePerSeat: 2500, isFree: false });
    bookings.push({ id: bookingId, tripId, passengerId: passenger.id, status: 'accepted',
      numberOfSeats: 1, paymentStatus: 'not_required', paymentMode: 'cash', paymentAmount: 2500, plannedDistanceMeters: 900,
      passengerOriginPoint: point(15.31), passengerDestinationPoint: point(15.318) });
    return { driver, passenger, tripId, bookingId };
  });
  const availableDrivers = Array.from({ length: p.availableDrivers }, () => account(true));
  const demands = Array.from({ length: p.requests }, () => ({ passenger: account(false) }));
  for (const [path, name, rows] of [
    ['users/entities/user.entity', 'User', users], ['vehicles/entities/vehicle.entity', 'Vehicle', vehicles],
    ['users/entities/kyc-document.entity', 'KycDocument', identities],
    ['trips/entities/trip.entity', 'Trip', trips], ['bookings/entities/booking.entity', 'Booking', bookings],
  ]) for (let i = 0; i < rows.length; i += 100) await db.getRepository(load(path)[name]).insert(rows.slice(i, i + 100));
  for (const driver of [...availableDrivers, ...journeys.map(j => j.driver)]) {
    const hash = createHash('sha256').update(driver.fcmToken + ':driver-v6').digest('hex');
    await db.query('INSERT INTO driver_notification_clients ("userId","tokenHash") VALUES ($1,$2)', [driver.id, hash]);
    if (!availableDrivers.includes(driver)) continue; // active GPS maintains real dispatch presence
    await db.query(`INSERT INTO driver_dispatch_presence
      ("driverId","vehicleId","leaseId",seats,position,"expiresAt","updatedAt","discoveryEnabled")
      VALUES ($1,$2,$3,4,ST_SetSRID(ST_MakePoint(15.31,-4.3),4326)::geography,now()+interval '3 hours',now(),true)`,
    [driver.id, driver.vehicleId, randomUUID()]);
  }
  await db.query('ANALYZE');
  return { journeys, demands, availableDrivers, schema: { entitySync: true, migrations, financialTriggers: false } };
}

async function outcomes(db) {
  const [rides] = await db.query(`SELECT count(*)::int AS bookings,
    count(*) FILTER (WHERE "pickedUp")::int AS "pickedUp",
    count(*) FILTER (WHERE "droppedOff")::int AS "droppedOff" FROM bookings`);
  const [dispatch] = await db.query(`SELECT count(DISTINCT "requestId")::int AS "requestsWithOffers",
    count(*)::int AS offers FROM trip_request_dispatch_offers`);
  const violations = await db.query(`SELECT "requestId" FROM trip_request_dispatch_offers
    WHERE status='pending' AND sequential=true GROUP BY "requestId" HAVING count(*)>4`);
  const duplicates = await db.query(`SELECT "driverId" FROM trip_request_dispatch_offers
    WHERE status='pending' GROUP BY "driverId" HAVING count(*)>1`);
  const accepted = await db.query(`SELECT "requestId" FROM trip_request_dispatch_offers
    WHERE status='accepted' GROUP BY "requestId" HAVING count(*)>1`);
  const requestStates = await db.query('SELECT status, count(*)::int AS count FROM trip_requests GROUP BY status');
  const [receipts] = await db.query('SELECT count(*)::int AS "deviceReceipts" FROM ride_notification_receipts');
  // Exact server-side elapsed times, separate allocation from delivery. No IDs or payloads leave the DB.
  const [allocation] = await db.query(`WITH first_offer AS (
    SELECT "requestId", min("createdAt") AS at FROM trip_request_dispatch_offers GROUP BY "requestId"
  ), waits AS (SELECT extract(epoch FROM (f.at-r."createdAt"))*1000 AS ms
    FROM trip_requests r LEFT JOIN first_offer f ON f."requestId"=r.id)
    SELECT count(ms)::int AS samples, count(*) FILTER(WHERE ms IS NULL)::int AS "requestsWithoutOffers",
      avg(ms)::float AS "meanMs", max(ms)::float AS "maxMs",
      percentile_cont(0.95) WITHIN GROUP(ORDER BY ms)::float AS "p95Ms" FROM waits`);
  const [delivery] = await db.query(`SELECT count(*)::int AS samples,
    avg(extract(epoch FROM (r."receivedAt"-n."createdAt"))*1000)::float AS "meanMs",
    max(extract(epoch FROM (r."receivedAt"-n."createdAt"))*1000)::float AS "maxMs",
    percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM (r."receivedAt"-n."createdAt"))*1000)::float AS "p95Ms"
    FROM ride_notification_receipts r JOIN notifications n ON n.id=r."notificationId"`);
  return { ...rides, ...dispatch, ...receipts, allocation, delivery,
    waveViolations: violations.length, duplicateDriverOffers: duplicates.length,
    duplicateAcceptances: accepted.length, requestStates };
}
async function dispatchSnapshot(db) {
  const [sample] = await db.query(`SELECT
    (SELECT count(*)::int FROM trip_requests r WHERE NOT EXISTS
      (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId"=r.id)) AS "requestsWithoutOffers",
    (SELECT count(*)::int FROM trip_request_dispatch_offers WHERE status='pending') AS "pendingOffers",
    (SELECT count(*)::int FROM driver_dispatch_presence p WHERE p."expiresAt">now() AND NOT EXISTS
      (SELECT 1 FROM trip_request_dispatch_offers o WHERE o."driverId"=p."driverId" AND o.status='pending'))
      AS "registeredUnreservedDrivers"`);
  return sample;
}
module.exports = { seed, outcomes, dispatchSnapshot };
