'use strict';
const { performance } = require('node:perf_hooks');
const { Metrics, ScheduleDiagnostics, healthSummary } = require('./metrics.cjs');
const { InFlightBudget } = require('./inflight-budget.cjs');
const { observeGenerator } = require('./generator-runtime.cjs');
const { whileScheduling } = require('./cooperative-wait.cjs');
const { captureSnapshot, firstFailureSnapshot } = require('./failure-snapshot.cjs');
const { connect, gps, httpClient } = require('./transport.cjs');
const { pointAt, requestBody } = require('./profile.cjs');
const { replicaFor } = require('./scenario-inputs.cjs');
const { captureAlertCohort, closeAlertCohort, reconcileAlertCohort, checkAlertCohort } = require('./alert-cohort.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function checkHealth(sample, p) {
  for (const server of sample.servers) {
    const admission = server.sqlAdmission;
    const response = server.responseAdmission;
    const receipt = server.receiptAdmission;
    if (!receipt || ![receipt.waiting, receipt.peakWaiting, receipt.oldestWaitingMs, receipt.wait?.maxMs,
      receipt.rejected?.full, receipt.rejected?.expired].every(Number.isFinite) ||
      receipt.peakWaiting > p.maxPoolWaiting || receipt.oldestWaitingMs > 1000 || receipt.wait.maxMs > 1000 ||
      receipt.rejected.full > 0 || receipt.rejected.expired > 0)
      throw new Error('Notification receipt admission safety gate failed');
    if (!response || ![response.waiting, response.peakWaiting, response.oldestWaitingMs, response.wait?.maxMs,
      response.rejected?.full, response.rejected?.expired].every(Number.isFinite) ||
      response.peakWaiting > p.maxPoolWaiting || response.oldestWaitingMs > 1000 || response.wait.maxMs > 1000 ||
      response.rejected.full > 0 || response.rejected.expired > 0 ||
      response.waiting + receipt.waiting + (admission?.waiting ?? 0) + (server.pool?.waiting ?? 0) > p.maxPoolWaiting)
      throw new Error('Dispatch response admission safety gate failed');
    if (!admission || ![admission.waiting, admission.peakWaiting, admission.oldestWaitingMs].every(Number.isFinite) ||
        !['progress', 'delivery', 'dispatch', 'maintenance'].every(lane =>
          Number.isFinite(admission.lanes?.[lane]?.deferred) && Number.isFinite(admission.lanes?.[lane]?.wait?.maxMs)) ||
        admission.waiting + server.pool?.waiting > p.maxPoolWaiting ||
        admission.peakWaiting > p.maxPoolWaiting || admission.oldestWaitingMs > 1000 ||
        Object.values(admission.lanes).some(lane => lane.deferred > 0 || lane.wait.maxMs > 1000))
      throw new Error('Background SQL admission safety gate failed');
  }
  if (sample.servers.length !== p.replicas || sample.servers.some(s => !Number.isFinite(s.peakRssMiB) ||
    !Number.isFinite(s.peakPoolWaiting) ||
    !Number.isFinite(s.pool?.waiting) || s.pool.waiting > p.maxPoolWaiting ||
    s.peakRssMiB > p.maxWorkerRssMiB || s.peakPoolWaiting > p.maxPoolWaiting ||
    s.redisReady === false || s.blockedExternalConnections !== 0 || s.workerErrors !== 0 || s.sqlErrors !== 0)) throw new Error('Backend safety gate failed');
  if (sample.evictions !== 0 || !Number.isFinite(sample.queue.oldestSeconds) ||
    sample.queue.oldestSeconds > p.maxQueueAgeSeconds) throw new Error('Queue/Redis safety gate failed');
}
function checkLatency(snap) {
  for (const name of ['driver_ack', 'passenger_ack', 'driver_peer', 'passenger_peer']) {
    if (!snap[name] || snap[name].failed || snap[name].p95UpperBoundMs === null ||
        !Number.isFinite(snap[name].p95UpperBoundMs) || snap[name].p95UpperBoundMs > 1000)
      throw new Error(`Latency/coverage gate failed: ${name}`);
  }
}

async function simulate(resources, p, report, writeCheckpoint, signal) {
  const { journeys, demands, availableDrivers } = resources.fixture, origins = resources.origins;
  const replica = index => replicaFor(index, p);
  const clients = [], active = [], tasks = new Set(), metrics = new Metrics();
  const inflight = new InFlightBudget(p.maxInflight);
  const http = httpClient(origins), alerts = new Set(), offeredRequests = new Set();
  let intervalMetrics = new Metrics();
  const record = (name, ms, ok = true) => { metrics.record(name, ms, ok); intervalMetrics.record(name, ms, ok); };
  const schedule = new ScheduleDiagnostics(p.maxSchedulerLagMs);
  const runtime = observeGenerator(() => report.currentPhase?.phase);
  let failure, backgroundRamp, alertCohort, stopping = false, lastHealth = 0, sent = 0, peerDeliveries = 0;
  let nextDemand = 0, demandStart = Infinity, terminalGps = 0, batchStart = 0, batchEnd = 0;
  const behaviorCounts = { accept: 0, decline: 0, ignore: 0, cancel: 0, conflicts: 0 };
  const alertGroups = { active: { received: 0, receipts: 0 }, available: { received: 0, receipts: 0 } };
  let redisFaultBaseline = [];
  const demandOwners = new Map(demands.map(d => [d.passenger.id, d]));
  const captureFailure = firstFailureSnapshot(() => resources.metrics(), () => ({
    phase: report.currentPhase?.phase, activeTrips: active.length,
    inflight: inflight.snapshot(), gpsSent: sent, peerDeliveries, requestsAttempted: nextDemand,
  }));
  const fail = e => {
    if (!failure) {
      failure = e;
      void captureFailure().then(snapshot => { report.failureSnapshot = snapshot; });
    }
  };
  function save() {
    const started = performance.now();
    let ok = false;
    try { writeCheckpoint(); ok = true; }
    finally {
      const elapsed = performance.now() - started;
      runtime.activity('report_write', started, elapsed); record('generator_report_write', elapsed, ok);
    }
  }
  function launch(name, fn, token = inflight.reserve([name])[0]) {
    const started = performance.now();
    const task = Promise.resolve().then(fn).then(ms => record(name, ms ?? performance.now() - started))
      .catch(e => { record(name, performance.now() - started, false); fail(e); })
      .finally(() => { tasks.delete(task); inflight.release(token); });
    tasks.add(task);
  }
  async function health() {
    const started = performance.now();
    let ok = false;
    try {
      const sample = await resources.metrics(); report.lastHealth = sample;
      report.healthHistory ||= [];
      report.healthHistory.push({ at: new Date().toISOString(), activeTrips: active.length, ...healthSummary(sample) });
      if (report.healthHistory.length > 180) report.healthHistory.shift();
      checkHealth(sample, p);
      if (sample.servers.some((s, i) => s.redisTransportErrors > (redisFaultBaseline[i] ?? 0)))
        throw new Error('Unexpected Redis transport error outside injected fault window');
      ok = true;
    } finally {
      const elapsed = performance.now() - started;
      runtime.activity('health', started, elapsed); record('generator_health', elapsed, ok);
    }
  }
  async function openJourney(j, i) {
    const driver = await connect(origins[replica(i)], '/tracking', j.driver.token, fail); clients.push(driver);
    const passenger = await connect(origins[replica(i + 1)], '/tracking', j.passenger.token, fail); clients.push(passenger);
    const passengerChat = await connect(origins[replica(i + 1)], '/chat', j.passenger.token, fail); clients.push(passengerChat);
    await resources.waitSocket(replica(i + 1), '/chat', passengerChat.socket.id, `user:${j.passenger.id}`);
    // Check server-owned authorization/rooms through parent-only IPC, without bypassing guards.
    await resources.waitSocket(replica(i), '/tracking', driver.socket.id);
    await resources.waitSocket(replica(i + 1), '/tracking', passenger.socket.id);
    driver.socket.emit('join_trip', { tripId: j.tripId });
    passenger.socket.emit('join_trip', { tripId: j.tripId });
    await resources.waitSocket(replica(i), '/tracking', driver.socket.id, `trip:${j.tripId}`);
    await resources.waitSocket(replica(i + 1), '/tracking', passenger.socket.id, `trip:${j.tripId}`);
    const row = { ...j, driverSocket: driver.socket, passengerSocket: passenger.socket,
      born: performance.now(), next: performance.now() + (i % p.maxTrips) * p.gpsIntervalMs / p.maxTrips,
      awaitingDriver: null, awaitingPassenger: null };
    passenger.socket.on('driver_location', value => {
      if (value?.tripId !== j.tripId) return fail(new Error('Driver location isolation violation'));
      if (row.awaitingDriver !== null && matchesPosition(value, row.expected)) { record('driver_peer', performance.now() - row.awaitingDriver); peerDeliveries++; row.awaitingDriver = null; }
    });
    driver.socket.on('passenger_location', value => {
      if (value?.tripId !== j.tripId || value.bookingId !== j.bookingId) return fail(new Error('Passenger location isolation violation'));
      if (row.awaitingPassenger !== null && matchesPosition(value, row.expected)) { record('passenger_peer', performance.now() - row.awaitingPassenger); peerDeliveries++; row.awaitingPassenger = null; }
    });
    passenger.socket.on('booking_auto_progress', value => {
      if (value?.tripId !== j.tripId) return fail(new Error('Progress event isolation violation'));
      if (value.events?.some(e => e.bookingId === j.bookingId && e.type === 'dropoff_confirmed')) row.ended = true;
    });
    active.push(row);
  }
  function send(row, now, finish) {
    if (row.awaitingDriver !== null || row.awaitingPassenger !== null) throw new Error('Peer GPS delivery missed its interval');
    const age = (now - row.born) / 1000;
    const payload = { tripId: row.tripId, coordinates: pointAt(age, finish), accuracy: 5,
      recordedAt: new Date().toISOString() };
    const [driverSlot, passengerSlot] = inflight.reserve(['driver_operation', 'passenger_operation']);
    row.expected = payload;
    row.awaitingDriver = performance.now(); row.awaitingPassenger = performance.now(); sent += 2;
    const sendOne = async (passenger) => {
      const result = await gps(passenger ? row.passengerSocket : row.driverSocket,
        passenger ? 'passenger_location_update' : 'driver_location_update',
        passenger ? { ...payload, bookingId: row.bookingId } : payload, p.ackTimeoutMs);
      if (result?.terminal) {
        terminalGps++; row.ended = true;
        row[passenger ? 'awaitingPassenger' : 'awaitingDriver'] = null;
        record('terminal_state_recovered', result.ms);
        return; // not an accepted GPS sample
      }
      record(passenger ? 'passenger_ack' : 'driver_ack', result);
    };
    launch('driver_operation', () => sendOne(false), driverSlot);
    launch('passenger_operation', () => sendOne(true), passengerSlot);
  }
  async function window(seconds, finish = false, sendGps = true) {
    try {
    const start = performance.now(), end = start + seconds * 1000;
    while (performance.now() < end) {
      if (signal.aborted) throw new Error('Interrupted');
      if (failure) throw failure;
      const now = performance.now();
      runtime.iteration(now);
      for (const row of active) if (!row.ended && sendGps && schedule.due('gps', now, row.next)) {
        send(row, now, finish ? Math.min(1, (now - start) / ((seconds - 5) * 1000)) : null);
        row.next += p.gpsIntervalMs;
      }
      if (nextDemand < batchEnd && now >= demandStart) {
        const due = demandStart + (nextDemand - batchStart) * p.requestWindowSeconds * 1000 / (batchEnd - batchStart);
        if (schedule.due('request', now, due)) {
          const i = nextDemand++, demand = demands[i];
          demand.started = performance.now();
          launch('request_create', async () => {
            demand.chat = await connect(origins[replica(i)], '/chat', demand.passenger.token, fail);
            clients.push(demand.chat);
            await resources.waitSocket(replica(i), '/chat', demand.chat.socket.id, `user:${demand.passenger.id}`);
            const result = await http.request(origins[replica(i)], '/api/v1/trip-requests', demand.passenger.token, requestBody());
            if (!result.body?.id) throw new Error('Created request id missing');
            demand.id = result.body.id;
            return result.ms;
          });
        }
      }
      for (let i = 0; i < availableDrivers.length; i++) {
        const driver = availableDrivers[i];
        if (driver.positionDue !== undefined && schedule.due('available_driver_position', now, driver.positionDue)) {
          driver.positionDue += 30000;
          launch('available_driver_position', async () => (await http.request(origins[replica(i)],
            '/api/v1/driver-dispatch/position', driver.token,
            { longitude: 15.31, latitude: -4.3, accuracy: 5, recordedAt: new Date().toISOString() }, 'PUT')).ms);
        }
      }
      if (now - lastHealth > 5000) { lastHealth = now; await health(); save(); }
      await pause(10);
    }
    } catch (error) { fail(error); throw error; }
  }
  async function beginBatch(count) {
    // Retire the previous cohort before its 30-minute expiry. Real authenticated
    // cancellation releases invitations; never rewrite deadlines directly in SQL.
    await Promise.all([...tasks]);
    for (let i = batchStart; i < batchEnd; i++) {
      const d = demands[i];
      if (d.id && !d.cancelled) {
        await http.request(origins[replica(i)], `/api/v1/trip-requests/${d.id}`, d.passenger.token, null, 'DELETE');
        d.cancelled = true;
        await window(.01);
      }
      if (d.chat) { d.chat.close(); const index = clients.indexOf(d.chat); if (index >= 0) clients.splice(index, 1); delete d.chat; }
    }
    batchStart = nextDemand; batchEnd = nextDemand + count;
    if (batchEnd > demands.length) throw new Error('Demand fixture budget exceeded');
    demandStart = performance.now();
  }
  try {
    // Keep generator data out of files. Backend authorization and throttles stay real.
    const alertDrivers = [...availableDrivers, ...journeys.map(j => j.driver)];
    for (let i = 0; i < alertDrivers.length; i++) {
      const driver = alertDrivers[i], client = await connect(origins[replica(i)], '/chat', driver.token, fail);
      clients.push(client); await resources.waitSocket(replica(i), '/chat', client.socket.id, `user:${driver.id}`);
      client.socket.on('ride_alert', event => {
        if (stopping) return;
        if (event?.recipientId !== driver.id) return fail(new Error('Alert recipient isolation violation'));
        if (event.kind !== 'incoming' || !event.eventId || alerts.has(event.eventId)) return;
        alerts.add(event.eventId);
        const group = availableDrivers.includes(driver) ? 'available' : 'active';
        alertGroups[group].received++;
        const owner = demandOwners.get(event.data?.passengerId);
        if (event.data?.tripRequestId && !offeredRequests.has(event.data.tripRequestId)) {
          offeredRequests.add(event.data.tripRequestId);
          if (owner?.started) record('first_alert', performance.now() - owner.started);
        }
        try { launch('alert_receipt', async () => {
          const receipt = await http.request(origins[replica(i)],
          `/api/v1/driver-dispatch/notifications/${event.eventId}/received`, driver.token,
          { stage: 'received', source: 'javascript', observedAt: new Date().toISOString() });
          alertGroups[group].receipts++; return receipt.ms;
        }); }
        catch (e) { fail(e); return; }
        try { if (p.behavior === 'mixed' && owner && availableDrivers.includes(driver) && event.data?.offerId) {
          // Active-trip candidates retain the real covoiturage consent flow; this
          // scenario only exercises immediate acceptance by available drivers.
          const scenario = demands.indexOf(owner) % 4;
          if (scenario === 2) { behaviorCounts.ignore++; return; }
          if (scenario === 3) {
            if (!owner.cancelling) {
              owner.cancelling = true;
              launch('request_cancel', async () => {
                await http.request(origins[replica(i)], `/api/v1/trip-requests/${event.data.tripRequestId}`,
                  owner.passenger.token, null, 'DELETE'); owner.cancelled = true; behaviorCounts.cancel++;
              });
            }
          } else {
            const decision = scenario === 1 && !owner.declined ? 'decline' : 'accept';
            if (decision === 'decline') owner.declined = true;
            launch('dispatch_response', async () => {
              const r = await http.request(origins[replica(i)], `/api/v1/driver-dispatch/offers/${event.data.offerId}/respond`,
                driver.token, { decision }, 'PUT', true);
              if (r.status === 409) behaviorCounts.conflicts++;
              else { behaviorCounts[decision]++; if (decision === 'accept') driver.positionDue = undefined; }
              return r.ms;
            });
          }
        } } catch (e) { fail(e); }
      });
    }
    // Inspector startup can pause an API for hundreds of ms. Start before the
    // first GPS, never suspend a live scheduler to enable diagnostics. The
    // bounded 180s window includes ramp-up and the first request wave; runs
    // with the profiler remain diagnostic, not capacity comparisons.
    if (p.profileCpu) await resources.cpuProfile('start');
    for (const [stageIndex, stage] of p.stages.entries()) {
      report.currentPhase = { phase: 'ramp', activeTrips: stage.trips };
      // Connection ramps are explicit and excluded from steady-state rate measurements.
      const rampStart = performance.now();
      // Existing journeys continue receiving GPS while additional clients connect.
      let rampDone = false;
      const ramp = backgroundRamp = (async () => {
        for (let i = active.length; i < stage.trips; i++) {
          if (failure || signal.aborted || stopping) break;
          await openJourney(journeys[i], i);
        }
      })().catch(fail).finally(() => { rampDone = true; });
      while (!rampDone) await window(1);
      await ramp;
      if (failure) throw failure;
      if (stageIndex === 0) {
        // Presence is refreshed through the API, not an UPDATE that bypasses eligibility.
        for (let i = 0; i < availableDrivers.length; i++) {
          const d = availableDrivers[i];
          const started = performance.now(), slot = inflight.reserve(['available_driver_presence'])[0];
          let ok = false;
          try {
            await whileScheduling(() => http.request(origins[replica(i)], '/api/v1/driver-dispatch/presence', d.token,
              { available: true, vehicleId: d.vehicleId, seats: 4, longitude: 15.31, latitude: -4.3 }, 'PUT'), () => window(.02));
            ok = true;
          } finally {
            inflight.release(slot);
            const elapsed = performance.now() - started;
            runtime.activity('presence', started, elapsed); record('generator_presence', elapsed, ok);
          }
          d.positionDue = performance.now() + 30000 + i * 30000 / availableDrivers.length;
        }
      }
      await beginBatch(p.stageRequests[stageIndex]);
      console.log(`Journey stage: ${stage.trips} active trips for ${stage.seconds}s`);
      report.currentPhase = { phase: 'steady', activeTrips: stage.trips };
      intervalMetrics = new Metrics();
      const before = sent, started = performance.now();
      await window(stage.seconds);
      await Promise.all([...tasks]);
      const snap = intervalMetrics.snapshot();
      report.stages.push({ activeTrips: stage.trips, rampSeconds: (started - rampStart) / 1000,
        elapsedSeconds: (performance.now() - started) / 1000, gpsSent: sent - before, metrics: snap });
      save();
      checkLatency(snap);
      const minimumGps = stage.trips * 2 * (Math.floor(stage.seconds / (p.gpsIntervalMs / 1000)) - 1);
      if (sent - before < minimumGps) throw new Error('Stage offered GPS rate not reached');
    }
    if (p.resilience) {
      report.currentPhase = { phase: 'fault-recovery', activeTrips: p.maxTrips };
      await Promise.all([...tasks]);
      const drainPeers = async () => {
        const deadline = performance.now() + p.ackTimeoutMs;
        while (active.some(r => r.awaitingDriver !== null || r.awaitingPassenger !== null)) {
          if (failure) throw failure;
          if (performance.now() > deadline) throw new Error('Pre-fault peer drain deadline');
          await pause(10);
        }
      };
      await drainPeers();
      // Pause only the test scheduler, then enqueue via actual authorized GPS.
      // The restarted worker must recover these committed jobs without reseeding.
      await resources.pauseProgress(true);
      for (const row of active) send(row, performance.now(), null);
      await Promise.all([...tasks]); await drainPeers();
      report.resilience = await require('./resilience.cjs').exerciseRecovery(resources, clients, active, p);
      redisFaultBaseline = report.resilience[0].after.servers.map(s => s.redisTransportErrors);
      for (const [i, d] of availableDrivers.entries()) d.positionDue = performance.now() + 30000 + i * 30000 / availableDrivers.length;
      // Resume normal gates after recovery. SQL failures and unexpected worker
      // failures are NOT waived; fault evidence remains separate from steady p95.
      intervalMetrics = new Metrics();
      await window(30); await Promise.all([...tasks]);
      checkLatency(intervalMetrics.snapshot());
      report.recoveryMetrics = intervalMetrics.snapshot();
    }
    if (p.resilience || p.behavior === 'mixed') {
      await Promise.all([...tasks]);
      report.delayedGps = await require('./delayed-gps.cjs').replayDelayedGps(active[0], p.ackTimeoutMs);
    }
    if (p.soakSeconds) {
      report.currentPhase = { phase: 'soak', activeTrips: p.maxTrips };
      console.log(`Soak: ${p.soakSeconds}s`); report.soak = [];
      const sliceSeconds = Math.min(300, p.renewSeconds);
      for (let elapsed = 0; elapsed < p.soakSeconds; elapsed += sliceSeconds) {
        intervalMetrics = new Metrics();
        const seconds = Math.min(sliceSeconds, p.soakSeconds - elapsed), before = sent;
        if (elapsed % p.renewSeconds === 0) await beginBatch(p.soakBatchRequests);
        await window(seconds); await Promise.all([...tasks]);
        const snap = intervalMetrics.snapshot(); checkLatency(snap);
        if (sent - before < p.maxTrips * 2 * (Math.floor(seconds * 1000 / p.gpsIntervalMs) - 1))
          throw new Error('Soak GPS rate not reached');
        report.soak.push({ seconds, gpsSent: sent - before, metrics: snap }); save();
      }
    }
    report.currentPhase = { phase: 'finish', activeTrips: p.maxTrips };
    await window(p.finishSeconds, true);
    report.currentPhase = { phase: 'drain', activeTrips: p.maxTrips };
    alertCohort = await captureAlertCohort(resources.db);
    report.alertObservationOpenedAt = new Date().toISOString();
    await window(p.drainSeconds, false, false);
    alertCohort = await closeAlertCohort(resources.db, alertCohort);
    report.alertObservationClosedAt = new Date().toISOString();
    stopping = true; // Freeze the receipt cohort before comparing its SQL and client counts.
    await Promise.all([...tasks]);
    if (failure) throw failure;
    await health();
    // A pruned final room must not hide a missing terminal transition.
    for (const row of active) {
      await require('./recovery.cjs').recoverTrackingState(row.passengerSocket,
        { tripId: row.tripId, bookingId: row.bookingId }, p.ackTimeoutMs);
      await require('./recovery.cjs').recoverTrackingState(row.driverSocket, { tripId: row.tripId }, p.ackTimeoutMs);
    }
    // Deliberately reproduce the old finish race on one authorized owner pair.
    // These two refused writes are probes, not part of the offered GPS rate.
    const probe = active[0], terminalPayload = { tripId: probe.tripId, coordinates: pointAt(100, 1), recordedAt: new Date().toISOString() };
    const probes = [await gps(probe.driverSocket, 'driver_location_update', terminalPayload, p.ackTimeoutMs),
      await gps(probe.passengerSocket, 'passenger_location_update', { ...terminalPayload, bookingId: probe.bookingId }, p.ackTimeoutMs)];
    if (probes.some(r => r?.terminal !== true)) throw new Error('Completed ride accepted a late GPS probe');
    report.terminalProbes = { refusedAndRecovered: probes.length };
    const outcomes = await require('./fixtures.cjs').outcomes(resources.db); report.outcomes = outcomes;
    report.alertCohort = await reconcileAlertCohort(resources.db, alertCohort, alerts, outcomes.offers);
    checkAlertCohort(report.alertCohort);
    if (outcomes.pickedUp !== p.maxTrips || outcomes.droppedOff !== p.maxTrips ||
        outcomes.waveViolations || outcomes.duplicateDriverOffers || outcomes.duplicateAcceptances || outcomes.requestsWithOffers !== p.requests ||
        offeredRequests.size !== p.requests || outcomes.deviceReceipts !== alerts.size || alerts.size === 0)
      throw new Error('Business outcome gate failed; inspect report');
    if (sent !== peerDeliveries + terminalGps || nextDemand !== p.requests) throw new Error('Delivered workload differs from plan');
    if (p.behavior === 'mixed' && ['accept', 'decline', 'ignore', 'cancel'].some(k => !behaviorCounts[k]))
      throw new Error('Mixed behavior coverage incomplete');
    report.localScenarioPassed = true;
    report.currentPhase = { phase: 'completed', activeTrips: p.maxTrips };
  } catch (error) {
    fail(error);
    throw failure;
  } finally {
    stopping = true;
    // Freeze generator evidence before draining sockets/SQL or cleaning fixtures.
    report.generatorRuntime = runtime.stop();
    if (failure) report.failureSnapshot = await captureFailure();
    await backgroundRamp;
    await Promise.allSettled([...tasks]);
    if (failure) report.postDrainSnapshot = await captureSnapshot(() => resources.metrics());
    report.generator = { peakInflight: inflight.peak, ...(inflight.rejected ? { admissionRejected: inflight.rejected } : {}),
      ...schedule.snapshot(), gpsSent: sent, peerDeliveries, terminalGps,
      requestsAttempted: nextDemand, uniqueAlertsReceived: alerts.size, requestsSeenInRealtime: offeredRequests.size, behaviorCounts, alertGroups };
    report.metrics = metrics.snapshot();
    report.lastIntervalMetrics = intervalMetrics.snapshot();
    if (resources.db?.isInitialized) {
      try { report.outcomes = await require('./fixtures.cjs').outcomes(resources.db); } catch { report.outcomesUnavailable = true; }
      if (!report.alertCohort && alertCohort && report.outcomes && !report.outcomesUnavailable) {
        try { report.alertCohort = await reconcileAlertCohort(resources.db, alertCohort, alerts, report.outcomes.offers); }
        catch { report.alertCohortUnavailable = true; }
      }
    }
    clients.forEach(c => c.close()); http.close();
  }
}
function matchesPosition(value, expected) {
  return expected && Array.isArray(value?.coordinates) && value.coordinates.length === 2 &&
    value.coordinates.every((n, i) => Math.abs(n - expected.coordinates[i]) < 1e-7) &&
    Date.parse(value.updatedAt) >= Date.parse(expected.recordedAt);
}
module.exports = { simulate, checkHealth, checkLatency, matchesPosition };
