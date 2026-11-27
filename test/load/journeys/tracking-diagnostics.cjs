'use strict';
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Metrics } = require('./metrics.cjs');

// Bench-only, fixed labels and bounded aggregate storage. Never keep arguments,
// Redis keys, SQL, packets, tokens, account ids, results or error messages.
const LABELS = [
  'ws_admission', 'driver_validation', 'passenger_validation', 'driver_service', 'passenger_service',
  ...['driver', 'passenger'].flatMap(role => ['read', 'write'].flatMap(operation =>
    [`${role}_${operation}`, `${role}_${operation}_pool`])),
  'driver_history', 'passenger_history', 'history_redis_append',
  'broadcast_driver', 'broadcast_passenger', 'publish_driver', 'publish_passenger', 'publish_other',
  'progress_claim', 'progress_finish', 'progress_handoff', 'progress_read', 'progress_read_pool', 'dispatch_retire',
];
class TrackingDiagnostics {
  constructor({ now = () => performance.now(), maxActiveSamples = 256 } = {}) {
    if (!Number.isSafeInteger(maxActiveSamples) || maxActiveSamples < 1 || maxActiveSamples > 2048)
      throw new Error('Invalid diagnostic sample bound');
    this.now = now; this.limit = maxActiveSamples; this.context = new AsyncLocalStorage();
    this.cumulative = new Metrics(); this.interval = new Metrics(); this.since = now();
    this.rows = new Map(LABELS.map(label => [label, { active: 0, peak: 0, intervalPeak: 0, starts: new Map() }]));
  }
  measure(label, work) {
    const row = this.rows.get(label);
    if (!row) throw new Error('Unknown tracking diagnostic label');
    const started = this.now(), token = {};
    if (row.starts.size < this.limit) row.starts.set(token, started);
    row.active++; row.peak = Math.max(row.peak, row.active); row.intervalPeak = Math.max(row.intervalPeak, row.active);
    let finished = false;
    const finish = ok => {
      if (finished) return;
      finished = true; row.active--; row.starts.delete(token);
      const elapsed = Math.max(0, this.now() - started);
      this.cumulative.record(label, elapsed, ok); this.interval.record(label, elapsed, ok);
    };
    try {
      const value = work();
      // Keep synchronous methods synchronous and preserve Promise identity and
      // rejections. The observer never turns a failed operation into a success.
      if (value && typeof value.then === 'function') value.then(() => finish(true), () => finish(false));
      else finish(true);
      return value;
    } catch (error) { finish(false); throw error; }
  }
  wrap(object, method, label, scoped = false) {
    const original = object[method], diagnostic = this;
    if (typeof original !== 'function' || !this.rows.has(label)) throw new Error('Missing tracking diagnostic hook');
    object[method] = function (...args) {
      const work = () => diagnostic.measure(label, () => original.apply(this, args));
      return scoped ? diagnostic.context.run(label, work) : work();
    };
  }
  installSql(db, load) {
    this.wrap(load('bookings/read-ride-progress'), 'readRideProgressBookings', 'progress_read', true);
    this.wrap(load('trip-requests/dispatch/retire-request-invitations'), 'retireRequestInvitations', 'dispatch_retire');
    for (const [method, label] of [['claimRideProgress', 'progress_claim'],
      ['finishRideProgress', 'progress_finish'], ['finishAndClaimRideProgress', 'progress_handoff']])
      this.wrap(load('tracking/ride-progress-queue'), method, label);
    for (const [role, read, write] of [
      ['driver', 'readDriverTrackingTrip', 'persistDriverLocation'],
      ['passenger', 'readPassengerTrackingBooking', 'persistPassengerLocation'],
    ]) {
      this.wrap(load('tracking/read-tracking-location'), read, `${role}_read`, true);
      this.wrap(load('tracking/persist-tracking-location'), write, `${role}_write`, true);
    }
    const obtain = db.driver.obtainMasterConnection, diagnostic = this;
    db.driver.obtainMasterConnection = function (...args) {
      const label = diagnostic.context.getStore();
      return ['driver_read', 'driver_write', 'passenger_read', 'passenger_write', 'progress_read'].includes(label)
        ? diagnostic.measure(`${label}_pool`, () => obtain.apply(this, args)) : obtain.apply(this, args);
    };
  }
  installProviders(app, load) {
    for (const [path, service, method, label] of [
      ['common/services/ws-session.service', 'WsSessionService', 'begin', 'ws_admission'],
      ['trips/trips.service', 'TripsService', 'updateDriverLocation', 'driver_service'],
      ['bookings/bookings.service', 'BookingsService', 'updatePassengerLocation', 'passenger_service'],
      ['common/services/location-history.service', 'LocationHistoryService', 'recordDriverLocation', 'driver_history'],
      ['common/services/location-history.service', 'LocationHistoryService', 'recordPassengerLocation', 'passenger_history'],
    ]) this.wrap(app.get(load(path)[service]), method, label);
    this.wrap(load('common/services/location-history-store'), 'appendLocationHistory', 'history_redis_append');
  }
  installPublisher(pub) {
    const publish = pub.publish, diagnostic = this;
    pub.publish = function (...args) {
      const scope = diagnostic.context.getStore();
      const role = scope === 'broadcast_driver' ? 'driver' : scope === 'broadcast_passenger' ? 'passenger' : 'other';
      return diagnostic.measure(`publish_${role}`, () => publish.apply(this, args));
    };
  }
  installValidation(prototype, driverDto, passengerDto) {
    const transform = prototype.transform, diagnostic = this;
    prototype.transform = function (value, metadata) {
      const label = metadata?.metatype === driverDto ? 'driver_validation'
        : metadata?.metatype === passengerDto ? 'passenger_validation' : null;
      return label ? diagnostic.measure(label, () => transform.call(this, value, metadata))
        : transform.call(this, value, metadata);
    };
  }
  installBroadcast(adapter) {
    const broadcast = adapter.broadcast, diagnostic = this;
    adapter.broadcast = function (packet, ...args) {
      const event = packet?.data?.[0];
      const label = event === 'driver_location' ? 'broadcast_driver'
        : event === 'passenger_location' ? 'broadcast_passenger' : null;
      if (!label) return broadcast.call(this, packet, ...args);
      return diagnostic.context.run(label, () => diagnostic.measure(label, () => broadcast.call(this, packet, ...args)));
    };
  }
  snapshot() {
    const now = this.now(), cumulative = this.cumulative.snapshot(), interval = this.interval.snapshot();
    const phases = Object.fromEntries([...this.rows].map(([label, row]) => {
      const value = { active: row.active, peakActive: row.peak, intervalPeakActive: row.intervalPeak,
        oldestActiveMs: row.active === row.starts.size ? (row.active ? now - row.starts.values().next().value : 0) : null,
        untrackedActiveSamples: row.active - row.starts.size,
        cumulative: cumulative[label] ?? null, interval: interval[label] ?? null };
      row.intervalPeak = row.active;
      return [label, value];
    }));
    const intervalMs = now - this.since; this.since = now; this.interval = new Metrics();
    return { intervalMs, phases };
  }
}
module.exports = { TrackingDiagnostics };
