'use strict';

// Planning is the default. These profiles never select an existing server.
const PROFILES = Object.freeze({
  smoke: { stages: [{ trips: 2, seconds: 75 }], requests: 2, requestWindowSeconds: 10, soakSeconds: 0 },
  'intermediate-sufficient': { stages: [{ trips: 10, seconds: 75 }, { trips: 50, seconds: 75 }, { trips: 100, seconds: 180 }],
    requests: 100, availableDrivers: 400, requestWindowSeconds: 60, soakSeconds: 0 },
  'intermediate-scarce': { stages: [{ trips: 10, seconds: 75 }, { trips: 50, seconds: 75 }, { trips: 100, seconds: 180 }],
    requests: 100, availableDrivers: 100, requestWindowSeconds: 60, soakSeconds: 0 },
  // Controlled comparisons against stage-250: keep rides, arrivals, workers and
  // safety limits unchanged. More available drivers also add chat/position load.
  'stage-250-sufficient': { stages: [{ trips: 250, seconds: 300 }], requests: 250,
    availableDrivers: 1000, requestWindowSeconds: 60, soakSeconds: 0 },
  'stage-250-mixed': { stages: [{ trips: 250, seconds: 300 }], requests: 250,
    availableDrivers: 250, requestWindowSeconds: 60, soakSeconds: 0, behavior: 'mixed' },
  'stage-500-mixed': { stages: [{ trips: 500, seconds: 300 }], requests: 500,
    availableDrivers: 500, requestWindowSeconds: 60, soakSeconds: 0, behavior: 'mixed' },
  // Explicit topology comparison before 750 (which already needs three APIs).
  // Same offered load and safety limits; never silently change the baseline.
  'stage-500-mixed-3api': { stages: [{ trips: 500, seconds: 300 }], requests: 500,
    availableDrivers: 500, requestWindowSeconds: 60, soakSeconds: 0, behavior: 'mixed', minimumReplicas: 3 },
  'stage-750-mixed': { stages: [{ trips: 750, seconds: 300 }], requests: 750,
    availableDrivers: 750, requestWindowSeconds: 60, soakSeconds: 0, behavior: 'mixed' },
  // Only after the short 750 stage passes. Refresh real synthetic demand during
  // the hold instead of letting all requests become terminal and calling it load.
  'stage-750-mixed-soak': { stages: [{ trips: 750, seconds: 300 }], requests: 750,
    availableDrivers: 750, requestWindowSeconds: 60, soakSeconds: 900, renewSeconds: 300, behavior: 'mixed' },
  'mixed-smoke': { stages: [{ trips: 5, seconds: 120 }], requests: 8, availableDrivers: 24,
    requestWindowSeconds: 30, soakSeconds: 0, behavior: 'mixed' },
  'mixed-smoke-3api': { stages: [{ trips: 5, seconds: 120 }], requests: 8, availableDrivers: 24,
    requestWindowSeconds: 30, soakSeconds: 0, behavior: 'mixed', minimumReplicas: 3 },
  'resilience-smoke': { stages: [{ trips: 2, seconds: 75 }], requests: 2, availableDrivers: 8,
    requestWindowSeconds: 10, soakSeconds: 0, resilience: true },
  'renewal-smoke': { stages: [{ trips: 2, seconds: 75 }], requests: 2, availableDrivers: 8,
    requestWindowSeconds: 10, soakSeconds: 90, renewSeconds: 45 },
  ...Object.fromEntries([100, 250, 500, 750, 1000].map(trips => [`stage-${trips}`, {
    stages: [{ trips, seconds: 300 }], requests: trips, requestWindowSeconds: 60, soakSeconds: 0,
  }])),
  capacity: { stages: [100, 250, 500, 750, 1000].map(trips => ({ trips, seconds: 300 })),
    requests: 1000, requestWindowSeconds: 60, soakSeconds: 3600 },
});
function profile(name) {
  if (!Object.hasOwn(PROFILES, name)) throw new Error(`Choose ${Object.keys(PROFILES).join(', ')}`);
  const p = structuredClone(PROFILES[name]);
  const batches = p.stages.map(s => p.behavior ? p.requests : s.trips);
  const renewSeconds = p.renewSeconds ?? 1200;
  const soakBatches = Math.ceil(p.soakSeconds / renewSeconds);
  const requests = batches.reduce((n, count) => n + count, 0) + soakBatches * p.requests;
  const availableDrivers = p.availableDrivers ?? p.requests;
  const maxTrips = p.stages.at(-1).trips;
  const peakDemandChats = Math.max(...batches, ...(p.soakSeconds ? [p.requests] : []));
  // Max 2000 sessions per backend, tracking and chat combined; reserve 20% headroom.
  const replicas = Math.max(p.minimumReplicas ?? 2, Math.ceil((maxTrips * 4 + availableDrivers + peakDemandChats) / 1600));
  return { name, ...p, requests, stageRequests: batches, soakBatchRequests: p.requests, renewSeconds,
    fixtureSeed: require('./scenario-inputs.cjs').DEFAULT_FIXTURE_SEED, replicaOffset: 0,
    availableDrivers, maxTrips, peakDemandChats, replicas, gpsIntervalMs: 5000,
    ackTimeoutMs: 5000, maxInflight: 128, maxSchedulerLagMs: 1000,
    maxWorkerRssMiB: 900, maxPoolWaiting: 50, maxQueueAgeSeconds: 15,
    // Thirty seconds to drive to the destination, then twenty seconds to drain work.
    finishSeconds: 30, drainSeconds: 20,
    capacityValidated: false, targetPolicy: 'fresh-local-resources-only' };
}
function describe(p) {
  return { profile: p.name, stages: p.stages, activeTrips: p.maxTrips,
    fixtureSeed: p.fixtureSeed, replicaOffset: p.replicaOffset,
    reproducibility: 'synthetic identities and replica mapping only; scheduling and business races remain real',
    trackingSockets: p.maxTrips * 2, additionalAlertSockets: p.availableDrivers,
    activeDriverAlertSockets: p.maxTrips, passengerChatSockets: p.maxTrips, requestPassengerChatSockets: p.peakDemandChats,
    totalSockets: p.maxTrips * 4 + p.availableDrivers + p.peakDemandChats,
    sessionLimitPerReplica: 2000, plannedSocketCeilingPerReplica: Math.ceil((p.maxTrips * 4 + p.availableDrivers + p.peakDemandChats) / p.replicas),
    gpsUpdatesPerSecond: p.maxTrips * 2 * 1000 / p.gpsIntervalMs,
    availableDriverPositionsPerSecond: p.availableDrivers / 30,
    availableDrivers: p.availableDrivers, stageRequests: p.stageRequests,
    additionalRequests: p.requests, renewalSeconds: p.renewSeconds, behavior: p.behavior ?? 'ignore',
    resilience: Boolean(p.resilience), requestArrivalsPerSecond: Math.max(...p.stageRequests) / p.requestWindowSeconds,
    durationSeconds: p.stages.reduce((n, s) => n + s.seconds, 0) + p.soakSeconds + p.finishSeconds + p.drainSeconds + (p.resilience ? 30 : 0),
    replicas: p.replicas, containerizedApi: Boolean(p.containerizedApi), profileSql: Boolean(p.profileSql),
    apiResourceLimits: require('./api-size.cjs').apiLimits(p), databasePoolMaxPerReplica: 10,
    topology: 'single-host-local', generatorSeparated: false,
    safetyLimits: Object.fromEntries(['gpsIntervalMs', 'ackTimeoutMs', 'maxInflight', 'maxSchedulerLagMs',
      'maxWorkerRssMiB', 'maxPoolWaiting', 'maxQueueAgeSeconds', 'finishSeconds', 'drainSeconds'].map(key => [key, p[key]])),
    profileCpu: Boolean(p.profileCpu), profileTracking: Boolean(p.profileTracking), externalProviders: 'sink; never delivered',
    targetPolicy: p.targetPolicy, capacityValidated: false };
}
function loopbackOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port ||
      u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    throw new Error('Only a parent-provisioned loopback origin is allowed');
  return u.origin;
}
function pointAt(ageSeconds, finish = null) {
  // Pickup at 15.31,-4.3. First 40s: 220m shared movement. Then cruise
  // between 220 and 440m; the destination at 880m is never crossed early.
  const cruise = .002 + (1 - Math.abs((Math.max(0, ageSeconds - 40) % 80) / 40 - 1)) * .002;
  const offset = ageSeconds < 40 ? .002 * Math.max(0, ageSeconds) / 40 : cruise;
  return [15.31 + (finish === null ? offset : offset + (.008 - offset) * Math.min(1, Math.max(0, finish))), -4.3];
}
function requestBody(now = Date.now()) {
  return { departureLocation: 'Synthetic load pickup', arrivalLocation: 'Synthetic load destination',
    departureReference: 'Test only', arrivalReference: 'Test only',
    departureCoordinates: [15.31, -4.3], arrivalCoordinates: [15.318, -4.3],
    departureDateMin: new Date(now + 60000).toISOString(), departureDateMax: new Date(now + 1800000).toISOString(),
    numberOfSeats: 1, maxPricePerSeat: 2500, vehicleType: 'car', paymentMode: 'cash', immediateDispatch: true };
}
module.exports = { profile, describe, loopbackOrigin, pointAt, requestBody };
