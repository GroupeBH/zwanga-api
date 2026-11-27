import { BookingsService } from '../../bookings/bookings.service';
import { resumeExpiredMapPriority } from '../target-map-driver';
import { recoverRequestAcceptance } from './request-acceptance';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { TripRequest } from '../entities/trip-request.entity';
import { NotificationService } from '../../notifications/notifications.service';
import { RideAlertChanges } from '../../notifications/ride-alert-changes';
import { enqueueTransactionalNotifications } from '../../notifications/transactional-notification';
import { rideSpeechData } from '../../notifications/ride-speech-data';
import { RequestDriverQueue } from './request-driver-queue';
import { sequentialCandidates } from './sequential-candidates';
import { reserveRequestWave } from './reserve-request-wave';
import { setDispatchTransactionTimeouts } from './dispatch-transaction';
import { retireRequestInvitations } from './retire-request-invitations';
import { requestVehicleTypes } from '../request-vehicle-types';
import { DriverAvailabilityWakeups } from './driver-availability-wakeups';
import { REQUEST_DISPATCH_PRIORITY_SQL } from './dispatch-scheduling-policy';
import { backgroundSql } from '../../database/background-sql-budget';
import { DispatchReadyQueue } from './dispatch-ready-queue';
import { DispatchDiagnostics, DispatchReason } from './dispatch-diagnostics';
import { dispatchPoolBusy, DISPATCH_PRESSURE_RETRY_MS } from './dispatch-pressure';

@Injectable()
export class SequentialDispatchService implements OnModuleDestroy {
  private readonly logger = new Logger(SequentialDispatchService.name);
  private ticking = false;
  private cacheUnavailableUntil = 0;
  private sqlFallbackWorkers = 0;
  private discoveryWorkers = 0;
  private readonly activeRequests = new Set<string>();
  private stopped = false;
  private pumping = false;
  private moreDue = false;
  private dueTimer?: ReturnType<typeof setTimeout>;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly diagnostics = new DispatchDiagnostics();
  private readonly ready = new DispatchReadyQueue(id => this.advance(id),
    () => this.activeRequests.size < 3, () => this.kickDue());
  constructor(private readonly db: DataSource, private readonly config: ConfigService,
    private readonly queue: RequestDriverQueue, private readonly notifications: NotificationService,
    private readonly changes: RideAlertChanges, private readonly bookings?: BookingsService,
    private readonly wakeups?: DriverAvailabilityWakeups) {
    wakeups?.bind(id => this.advance(id));
  }
  /** These entry points must only be invoked after the business commit. */
  async driverAvailable(driverId: string) {
    if (this.enabled) await this.wakeups?.driversAvailable([driverId]);
  }
  async requestReleased(id: string) {
    if (this.enabled) await this.wakeups?.requestReleased(id);
  }
  private get enabled() { return !this.stopped && this.config.get('DRIVER_DISPATCH_ENABLED') === 'true'; }
  diagnosticSnapshot() {
    return { ...this.diagnostics.snapshot(), localQueue: this.ready.snapshot(), active: this.activeRequests.size };
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.dueTimer) clearTimeout(this.dueTimer);
    await this.ready.stop();
    await Promise.all(this.inFlight);
  }
  private trackWork(): () => void {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    this.inFlight.add(done);
    return () => { this.inFlight.delete(done); resolve(); };
  }
  private get waveSize() {
    // Explicit 1 supports a controlled operational fallback; never allow unbounded fan-out.
    return String(this.config.get('DRIVER_DISPATCH_WAVE_SIZE') ?? '4') === '1' ? 1 : 4;
  }
  private open(r: TripRequest | null): r is TripRequest {
    return !!r && ['pending', 'offers_received'].includes(r.status) && !r.selectedDriverId && !r.tripId &&
      !!r.departurePoint && r.departureDateMax.getTime() > Date.now();
  }
  private async lock(manager: EntityManager, id: string) {
    await setDispatchTransactionTimeouts(manager);
    return manager.getRepository(TripRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' },
      // Read-only dispatch projection, never save this as a full request. Keep
      // recovery, target-map priority and version checks; omit route/history JSON.
      select: { id: true, status: true, sequentialDispatch: true, selectedDriverId: true,
        tripId: true, selectedAt: true, passengerId: true, immediateDispatch: true,
        departurePoint: true, departureDateMin: true, departureDateMax: true,
        departureLocation: true, arrivalLocation: true, targetDriverId: true,
        targetDriverPriorityUntil: true, paymentMode: true, maxPricePerSeat: true,
        numberOfSeats: true, vehicleType: true, vehicleTypes: true } });
  }
  private queueVersion(request: TripRequest) {
    return createHash('sha256').update(JSON.stringify([request.departurePoint, requestVehicleTypes(request),
      request.numberOfSeats, request.targetDriverId, request.paymentMode, request.maxPricePerSeat,
      request.departureDateMin, request.departureDateMax])).digest('hex');
  }
  /** Do not repeatedly stall every request during a Redis outage. SQL keeps committed actions safe. */
  private async cache<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    if (Date.now() < this.cacheUnavailableUntil) return fallback;
    try { return await this.diagnostics.measure('redis', operation); }
    catch {
      this.cacheUnavailableUntil = Date.now() + 5000;
      this.logger.warn('Request queue unavailable; bounded SQL relay recovery active.');
      return fallback;
    }
  }
  private async retire(manager: EntityManager, id: string, terminal: boolean, releasedDrivers?: string[]) {
    return retireRequestInvitations(manager, id, terminal, releasedDrivers);
  }
  /** Discovery ticks skip waiting offers without taking SQL row locks. Events bypass this cache. */
  async poll(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    return await this.cache(() => this.queue.isDue(id), true) ? this.advance(id) : false;
  }
  /** Redis caches ordering; SQL bounds the wave and commits every invitation with its outbox. */
  async advance(id: string): Promise<boolean> {
    if (!this.enabled) { this.diagnostics.record('inactive'); return false; }
    // One budget shared by HTTP creation, expiry cron, fallback scan and hints.
    // Separate per-lane limits otherwise add up and consume the SQL pool during
    // a burst of released drivers. Coalesce same-process duplicates as well.
    if (this.activeRequests.has(id)) { this.diagnostics.record('duplicate'); return false; }
    if (this.activeRequests.size >= 3) {
      this.diagnostics.record('local_capacity');
      await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
      // Retain durable recovery first. A freed local slot can now take over
      // immediately; overflow still has its Redis/SQL retry, never extra workers.
      this.ready.enqueue(id);
      return false;
    }
    this.activeRequests.add(id);
    const finishWork = this.trackWork();
    const startedAt = Date.now();
    let discoveryMs = 0;
    let token: string | undefined, selectedDriverId: string | undefined, resetQueue = false;
    let sqlFallback = false;
    let reason: DispatchReason = 'error';
    try {
      const releasedDrivers: string[] = [];
      const state = await this.diagnostics.measure('state', () => backgroundSql(this.db, 'dispatch', () => this.db.transaction(async manager => {
        const request = await this.lock(manager, id);
        if (request) {
          const recovery = await recoverRequestAcceptance(manager, request);
          if (recovery && 'complete' in recovery) { await this.retire(manager, id, true, releasedDrivers); return null; }
          if (recovery) return recovery;
        }
        if (!this.open(request)) { await this.retire(manager, id, true, releasedDrivers); return null; }
        if (!request.sequentialDispatch) {
          // Adopt an old broadcast only once; never keep concurrent legacy invitations.
          await this.retire(manager, id, true, releasedDrivers);
          await manager.getRepository(TripRequest).update(id, { sequentialDispatch: true, updatedAt: () => '"updatedAt"' });
          request.sequentialDispatch = true;
        }

        let changed = await this.retire(manager, id, false, releasedDrivers);
        changed = await resumeExpiredMapPriority(manager, request) || changed;
        // If the alert was dismissed or could not be delivered, keep the selected
        // driver's exclusive response window until its durable server deadline.
        if (request.targetDriverPriorityUntil && request.targetDriverPriorityUntil.getTime() > Date.now())
          return { wait: request.targetDriverPriorityUntil.getTime(), changed };
        // Both reads are protected by the request lock. Avoid a second SQL trip
        // on the first-offer path, and skip history while a wave is still live.
        const [offers] = await manager.query(`WITH pending AS MATERIALIZED (
          SELECT "expiresAt" FROM trip_request_dispatch_offers WHERE "requestId"=$1
            AND status='pending' AND "expiresAt">now() ORDER BY "expiresAt" LIMIT 1
        ) SELECT (SELECT "expiresAt" FROM pending) AS "expiresAt",
          (SELECT id FROM trip_request_dispatch_offers WHERE "requestId"=$1
            AND NOT EXISTS (SELECT 1 FROM pending) ORDER BY "createdAt" DESC, id LIMIT 1) AS "historyId"`, [id]);
        if (offers.expiresAt) return { wait: new Date(offers.expiresAt).getTime(), changed };
        return { request, changed, hasBeenOffered: !!offers.historyId, discoveryGeneration: offers.historyId ?? 'first' };
      })));
      // SQL retirement has committed. Wake waiting neighbours before allowing an
      // expired wave to recapture every freed attention slot.
      const yielded = releasedDrivers.length
        ? await this.wakeups?.driversAvailable(releasedDrivers, id) : false;
      if (!state || ('changed' in state && state.changed)) this.changes.enqueue({ kind: 'request', id, terminal: !state });
      if (!state) {
        reason = 'closed';
        await this.cache(() => this.queue.close(id), undefined);
        if (!releasedDrivers.length) await this.wakeups?.requestReleased(id);
        return false;
      }
      if ('bookingId' in state) {
        reason = 'recovery';
        if (!this.bookings) throw new Error('Booking recovery service unavailable');
        await this.bookings.acceptBooking(state.bookingId, state.driverId);
        await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
        return false;
      }
      if ('wait' in state) {
        reason = 'live_window';
        await this.cache(() => this.queue.schedule(id, state.wait!), undefined); return false;
      }
      if (yielded) {
        reason = 'fairness_yield';
        await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined); return false;
      }
      // Retirement/recovery above always runs. Do not amplify an existing SQL
      // backlog with candidate discovery and another wave of receipt traffic.
      if (dispatchPoolBusy(this.db)) {
        reason = 'sql_pressure';
        await this.cache(() => this.queue.schedule(id, Date.now() + DISPATCH_PRESSURE_RETRY_MS), undefined);
        return false;
      }
      const version = this.queueVersion(state.request);
      const claim = await this.cache(() => this.queue.claim(id, version), null);
      if (!claim) {
        // Only a Redis failure enables SQL discovery. A healthy, contended lease
        // must retain its owner's ordering, rather than trigger a second search.
        if (Date.now() < this.cacheUnavailableUntil && this.sqlFallbackWorkers < 3) {
          this.sqlFallbackWorkers++; sqlFallback = true;
        } else {
          reason = 'redis_contention';
          // Another worker may be between queue claim and SQL commit, or may have
          // crashed. Retry via Redis after its lease, not only the global 25-row scan.
          await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
          return false;
        }
      }
      token = claim?.token;
      let drivers = claim?.drivers ?? [];
      if (!drivers.length) {
        // Discovery (including pool wait) must not consume the Redis lease. SQL
        // revalidates the request/version and candidate before reserving anyone.
        if (token) {
          await this.cache(() => this.queue.release(id, token!), undefined);
          token = undefined;
        }
        if (this.discoveryWorkers >= 3) {
          reason = 'discovery_throttled';
          await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
          return false;
        }
        if (!await this.cache(() => this.queue.claimDiscovery(id, version + ':' + state.discoveryGeneration), true)) {
          reason = 'discovery_throttled';
          await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined); return false;
        }
        this.discoveryWorkers++;
        const discoveryStartedAt = Date.now();
        let candidates: Awaited<ReturnType<typeof sequentialCandidates>>;
        try {
          candidates = await this.diagnostics.measure('discovery', () => backgroundSql(this.db, 'dispatch', () => this.db.transaction(async manager => {
            await manager.query("SET LOCAL statement_timeout = '3s'");
            return sequentialCandidates(manager, state.request);
          })));
        } finally {
          discoveryMs = Date.now() - discoveryStartedAt;
          this.discoveryWorkers--;
        }
        drivers = [...new Set(candidates.map(candidate => candidate.driverId))];
        if (!sqlFallback) {
          const fresh = await this.cache(() => this.queue.claim(id, version), null);
          if (!fresh) {
            reason = 'redis_contention';
            await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
            return false;
          }
          token = fresh.token;
          if (fresh.drivers.length) drivers = fresh.drivers;
          else if (!await this.cache(() => this.queue.seed(id, token!, version, drivers), false)) {
            reason = 'redis_contention';
            await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
            return false;
          }
        }
      }
      if (!drivers.length) {
        reason = 'no_candidates';
        await this.cache(() => this.queue.retryEmpty(id, state.hasBeenOffered), 15000); return false;
      }
      // Recheck after discovery/Redis: pressure may have appeared meanwhile.
      // No SQL connection is held here; finally releases any candidate lease.
      if (dispatchPoolBusy(this.db)) {
        reason = 'sql_pressure';
        await this.cache(() => this.queue.schedule(id, Date.now() + DISPATCH_PRESSURE_RETRY_MS), undefined);
        return false;
      }
      const result = await this.diagnostics.measure('reservation', () => backgroundSql(this.db, 'dispatch', () => this.db.transaction(async manager => {
        const request = await this.lock(manager, id);
        if (!this.open(request)) return { wait: Date.now(), reset: true };
        if (this.queueVersion(request) !== version) return { wait: Date.now(), reset: true };
        const recovery = await recoverRequestAcceptance(manager, request);
        if (recovery) return { wait: Date.now() + 1000, reset: false };
        const [pending] = await manager.query(`SELECT "expiresAt" FROM trip_request_dispatch_offers
          WHERE "requestId"=$1 AND status='pending' ORDER BY "expiresAt" LIMIT 1`, [id]);
        if (pending) return { wait: new Date(pending.expiresAt).getTime(), reset: false };
        const claimed = await reserveRequestWave(manager, request, drivers, this.waveSize);
        if (!claimed.length) return { empty: true, wait: Date.now() + 1000, reset: true };
        await enqueueTransactionalNotifications(manager, claimed.map(({ candidate, offerId, expiresAt: deadline }) => {
          const driverId = candidate.driverId;
          const expiresAt = deadline.toISOString();
          return { eventKey: 'sequential-offer:' + offerId, userId: driverId,
            title: 'Nouvelle commande de trajet', body: request.departureLocation + ' → ' + request.arrivalLocation + '. Accepter ou refuser ?',
            data: { type: request.immediateDispatch && !candidate.existingTripId ? 'driver_dispatch_offer' : 'trip_request_nearby',
              ...(candidate.existingTripId ? { sharedTrip: true, existingTripId: candidate.existingTripId } : {}),
              ringAlert: 'nearby-request-v1', tripRequestId: id, offerId, driverId, passengerId: request.passengerId,
              role: 'driver', vehicleType: request.vehicleType, vehicleTypes: JSON.stringify(requestVehicleTypes(request)), expiresAt, alertExpiresAt: expiresAt,
              ...rideSpeechData({ departure: request.departureLocation, arrival: request.arrivalLocation,
                seats: request.numberOfSeats, departureAt: request.departureDateMin,
                pricePerSeat: request.maxPricePerSeat, priceKind: 'budget' }) } };
        }));
        return { offeredUntil: Math.min(...claimed.map(invitation => invitation.expiresAt.getTime())),
          driverId: claimed[claimed.length - 1].candidate.driverId, reset: false };
      })));
      reason = 'offeredUntil' in result ? 'offered' : 'empty' in result ? 'reservation_race'
        : result.reset ? 'request_changed' : 'live_window';
      // Start fresh push/realtime immediately after commit, before even one Redis round trip.
      if ('offeredUntil' in result) {
        void this.notifications.dispatchUrgentNotifications()
          .catch(() => this.logger.warn('Queued request push deferred.'));
        this.logger.log(`REQUEST_DISPATCH_TIMING requestId=${id} elapsedMs=${Date.now() - startedAt} discoveryMs=${discoveryMs}`);
        await this.cache(() => this.queue.offered(id), undefined);
      }
      selectedDriverId = result.driverId;
      resetQueue = result.reset;
      if ('empty' in result) await this.cache(() => this.queue.retryEmpty(id, state.hasBeenOffered), 15000);
      else await this.cache(() => this.queue.schedule(id, result.offeredUntil ?? result.wait!), undefined);
      return 'offeredUntil' in result;
    } catch (error) {
      // SQL + its indexed recovery scan survive Redis eviction, timeout or a process restart.
      // Never bypass bounded invitations and durable single-driver constraints.
      const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'unknown');
      reason = code === 'SQL_BACKGROUND_ADMISSION_DEFERRED' ? 'sql_deferred' : 'error';
      this.logger.warn('Request relay deferred id=' + id + ' code=' + code);
      // Retirement may already have committed. Keep a wake-up even when there
      // is no pending SQL invitation left for the expiration recovery scan.
      await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
      return false;
    } finally {
      if (sqlFallback) this.sqlFallbackWorkers--;
      if (token) await this.queue.release(id, token, selectedDriverId, resetQueue)
        .catch(() => this.logger.warn('Request queue lease release deferred; lease expires automatically.'));
      this.diagnostics.record(reason);
      this.diagnostics.duration('attempt', Date.now() - startedAt);
      this.activeRequests.delete(id);
      this.ready.wake();
      this.kickDue();
      finishWork();
    }
  }
  /** Small Redis batches leave work available to other replicas. Refill on
   * completion, not a busy poll; an empty read waits for the next cron/event. */
  private async readDue(): Promise<string[]> {
    const limit = Math.min(6 - this.ready.readySize - this.activeRequests.size, 128 - this.ready.size);
    if (limit <= 0) return [];
    if (Date.now() < this.cacheUnavailableUntil) { this.moreDue = false; return []; }
    const ids = await this.cache(() => this.queue.claimDue(Date.now(), limit), [] as string[]);
    this.moreDue = ids.length === limit;
    return ids;
  }
  private async orderDue(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows: { id: string }[] = await backgroundSql(this.db, 'dispatch', () => this.db.query(`SELECT r.id FROM trip_requests r
      WHERE r.id=ANY($1::uuid[]) ORDER BY ${REQUEST_DISPATCH_PRIORITY_SQL}, r.id`, [ids]))
      .catch(() => ids.map(id => ({ id })));
    const ordered = new Set(rows.map(row => row.id));
    return [...ordered, ...ids.filter(id => !ordered.has(id))];
  }
  private kickDue() {
    if (!this.enabled || !this.moreDue || this.ticking || this.pumping || this.dueTimer) return;
    if (this.ready.readySize + this.activeRequests.size >= 6 || this.ready.size >= 128) return;
    this.dueTimer = setTimeout(() => {
      this.dueTimer = undefined;
      void this.pumpDue();
    }, 25);
    this.dueTimer.unref();
  }
  private async pumpDue() {
    if (!this.enabled || this.ticking || this.pumping) return;
    this.pumping = true;
    const finishWork = this.trackWork();
    try {
      const ids = await this.orderDue(await this.readDue());
      await Promise.all(ids.filter(id => !this.activeRequests.has(id)).map(id => this.ready.enqueue(id)));
    } catch { this.moreDue = false; this.logger.warn('Request ready refill deferred.'); }
    finally { this.pumping = false; this.kickDue(); finishWork(); }
  }
  @Cron('* * * * * *')
  async deadlines(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    const finishWork = this.trackWork();
    try {
      // Start Redis independently, but process SQL expirations without waiting for its response.
      const dueRead = this.pumping ? Promise.resolve([] as string[]) : this.readDue();
      const rows: { requestId: string }[] = await backgroundSql(this.db, 'dispatch', () => this.db.query(`SELECT "requestId" FROM (SELECT "requestId", "expiresAt" FROM trip_request_dispatch_offers
          WHERE sequential = true AND status = 'pending' AND "expiresAt" <= now()
          UNION ALL SELECT id AS "requestId", "targetDriverPriorityUntil" AS "expiresAt" FROM trip_requests
          WHERE "targetDriverPriorityUntil" IS NOT NULL AND "targetDriverPriorityUntil"<=now()
            AND status IN ('pending','offers_received') AND "selectedDriverId" IS NULL AND "tripId" IS NULL) deadlines
          ORDER BY "expiresAt", "requestId" LIMIT 50`)).catch(() => {
            // An isolated failure of the recovery query must not discard an
            // already successful Redis read and stop every timed handoff.
            this.logger.warn('SQL request expiration scan deferred; processing Redis deadlines.');
            return [] as { requestId: string }[];
          });
      const expired = new Set(rows.map(row => row.requestId));
      const due = (await dueRead).filter(id => !expired.has(id));
      const ordered = await this.orderDue(due);
      // Both lanes share three relays and alternate when backlogged. Expiration
      // recovery must not consume all slots before first offers are considered.
      const jobs = [...expired].filter(id => !this.activeRequests.has(id)).map(id => this.ready.enqueue(id, 'recovery'));
      jobs.push(...ordered.filter(id => !this.activeRequests.has(id)).map(id => this.ready.enqueue(id)));
      await Promise.all(jobs);
    } catch { this.logger.warn('Request deadline scan deferred.'); }
    finally { this.ticking = false; this.kickDue(); finishWork(); }
  }
}
