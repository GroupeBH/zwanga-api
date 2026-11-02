import { BookingsService } from '../../bookings/bookings.service';
import { resumeExpiredMapPriority } from '../target-map-driver';
import { recoverRequestAcceptance } from './request-acceptance';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { TripRequest } from '../entities/trip-request.entity';
import { NotificationService } from '../../notifications/notifications.service';
import { RideAlertChanges } from '../../notifications/ride-alert-changes';
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';
import { rideSpeechData } from '../../notifications/ride-speech-data';
import { RequestDriverQueue } from './request-driver-queue';
import { lockNextQueuedCandidate, sequentialCandidates } from './sequential-candidates';
import { REQUEST_RESPONSE_MS } from './sequential-policy';
import { retireRequestInvitations } from './retire-request-invitations';
import { requestVehicleTypes } from '../request-vehicle-types';

@Injectable()
export class SequentialDispatchService {
  private readonly logger = new Logger(SequentialDispatchService.name);
  private ticking = false;
  private cacheUnavailableUntil = 0;
  private sqlFallbackWorkers = 0;
  private discoveryWorkers = 0;
  constructor(private readonly db: DataSource, private readonly config: ConfigService,
    private readonly queue: RequestDriverQueue, private readonly notifications: NotificationService,
    private readonly changes: RideAlertChanges, private readonly bookings?: BookingsService) {}
  private get enabled() { return this.config.get('DRIVER_DISPATCH_ENABLED') === 'true'; }
  private open(r: TripRequest | null): r is TripRequest {
    return !!r && ['pending', 'offers_received'].includes(r.status) && !r.selectedDriverId && !r.tripId &&
      !!r.departurePoint && r.departureDateMax.getTime() > Date.now();
  }
  private async lock(manager: EntityManager, id: string) {
    await manager.query("SET LOCAL lock_timeout = '2s'");
    await manager.query("SET LOCAL statement_timeout = '5s'");
    return manager.getRepository(TripRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }
  private queueVersion(request: TripRequest) {
    return createHash('sha256').update(JSON.stringify([request.departurePoint, requestVehicleTypes(request),
      request.numberOfSeats, request.targetDriverId, request.paymentMode, request.maxPricePerSeat,
      request.departureDateMin, request.departureDateMax])).digest('hex');
  }
  /** Do not repeatedly stall every request during a Redis outage. SQL keeps committed actions safe. */
  private async cache<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    if (Date.now() < this.cacheUnavailableUntil) return fallback;
    try { return await operation(); }
    catch {
      this.cacheUnavailableUntil = Date.now() + 5000;
      this.logger.warn('Request queue unavailable; bounded SQL relay recovery active.');
      return fallback;
    }
  }
  private async retire(manager: EntityManager, id: string, terminal: boolean) {
    return retireRequestInvitations(manager, id, terminal);
  }
  /** Discovery ticks skip waiting offers without taking SQL row locks. Events bypass this cache. */
  async poll(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    return await this.cache(() => this.queue.isDue(id), true) ? this.advance(id) : false;
  }
  /** Redis caches ordering; SQL remains the authority for exclusive invitation + outbox. */
  async advance(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    let token: string | undefined, selectedDriverId: string | undefined, resetQueue = false;
    let sqlFallback = false;
    try {
      const state = await this.db.transaction(async manager => {
        const request = await this.lock(manager, id);
        if (request) {
          const recovery = await recoverRequestAcceptance(manager, request);
          if (recovery && 'complete' in recovery) { await this.retire(manager, id, true); return null; }
          if (recovery) return recovery;
        }
        if (!this.open(request)) { await this.retire(manager, id, true); return null; }
        if (!request.sequentialDispatch) {
          // Adopt an old broadcast only once; never keep concurrent legacy invitations.
          await this.retire(manager, id, true);
          await manager.getRepository(TripRequest).update(id, { sequentialDispatch: true, updatedAt: () => '"updatedAt"' });
          request.sequentialDispatch = true;
        }

        let changed = await this.retire(manager, id, false);
        changed = await resumeExpiredMapPriority(manager, request) || changed;
        // If the alert was dismissed or could not be delivered, keep the selected
        // driver's exclusive response window until its durable server deadline.
        if (request.targetDriverPriorityUntil && request.targetDriverPriorityUntil.getTime() > Date.now())
          return { wait: request.targetDriverPriorityUntil.getTime(), changed };
        const [pending] = await manager.query(`SELECT "expiresAt" FROM trip_request_dispatch_offers
          WHERE "requestId" = $1 AND status = 'pending' AND "expiresAt" > now() LIMIT 1`, [id]);
        return pending ? { wait: new Date(pending.expiresAt).getTime(), changed } : { request, changed };
      });
      if (!state || ('changed' in state && state.changed)) this.changes.enqueue({ kind: 'request', id, terminal: !state });
      if (!state) { await this.cache(() => this.queue.close(id), undefined); return false; }
      if ('bookingId' in state) {
        if (!this.bookings) throw new Error('Booking recovery service unavailable');
        await this.bookings.acceptBooking(state.bookingId, state.driverId);
        await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
        return false;
      }
      if ('wait' in state) {
        await this.cache(() => this.queue.schedule(id, state.wait!), undefined); return false;
      }
      const version = this.queueVersion(state.request);
      const claim = await this.cache(() => this.queue.claim(id, version), null);
      if (!claim) {
        // Only a Redis failure enables SQL discovery. A healthy, contended lease
        // must retain its owner's ordering, rather than trigger a second search.
        if (Date.now() < this.cacheUnavailableUntil && this.sqlFallbackWorkers < 3) {
          this.sqlFallbackWorkers++; sqlFallback = true;
        } else {
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
          await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
          return false;
        }
        this.discoveryWorkers++;
        let candidates: Awaited<ReturnType<typeof sequentialCandidates>>;
        try {
          candidates = await this.db.transaction(async manager => {
            await manager.query("SET LOCAL statement_timeout = '3s'");
            return sequentialCandidates(manager, state.request);
          });
        } finally { this.discoveryWorkers--; }
        drivers = [...new Set(candidates.map(candidate => candidate.driverId))];
        if (!sqlFallback) {
          const fresh = await this.cache(() => this.queue.claim(id, version), null);
          if (!fresh) {
            await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
            return false;
          }
          token = fresh.token;
          if (fresh.drivers.length) drivers = fresh.drivers;
          else if (!await this.cache(() => this.queue.seed(id, token!, version, drivers), false)) {
            await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
            return false;
          }
        }
      }
      if (!drivers.length) {
        await this.cache(() => this.queue.schedule(id, Date.now() + 15_000), undefined); return false;
      }
      const result = await this.db.transaction(async manager => {
        const request = await this.lock(manager, id);
        if (!this.open(request)) return { wait: Date.now(), reset: true };
        if (this.queueVersion(request) !== version) return { wait: Date.now(), reset: true };
        const recovery = await recoverRequestAcceptance(manager, request);
        if (recovery) return { wait: Date.now() + 1000, reset: false };
        const [pending] = await manager.query(`SELECT "expiresAt" FROM trip_request_dispatch_offers
          WHERE "requestId"=$1 AND status='pending' LIMIT 1`, [id]);
        if (pending) return { wait: new Date(pending.expiresAt).getTime(), reset: false };
        const claimed = await (async () => {
          // A different request can commit between the candidate query's snapshot
          // and its row lock. Conflict-safe insertion + a fresh snapshot handles
          // that race without rolling back retirement or waiting for the next cron.
          // Usually one indexed validation, with no geographic re-ranking of the
          // other 49 candidates. Bound work when many cached drivers became busy;
          // an exhausted window is refreshed on the next Redis deadline.
          let remaining = drivers;
          for (let attempt = 0; attempt < 8; attempt++) {
            const checked = await lockNextQueuedCandidate(manager, request, remaining);
            if (!checked) return null;
            remaining = remaining.filter(driverId => driverId !== checked.driverId);
            const candidate = checked.candidate;
            if (!candidate) continue;
            const offerId = randomUUID();
            const [offer] = await manager.query(`INSERT INTO trip_request_dispatch_offers
              (id,"requestId","driverId","vehicleId",seats,"expiresAt",sequential)
              VALUES ($1,$2,$3,$4,$5,LEAST(clock_timestamp() + $6 * interval '1 millisecond', $7),true)
              ON CONFLICT DO NOTHING RETURNING "expiresAt"`,
              [offerId,id,candidate.driverId,candidate.vehicleId,candidate.seats,REQUEST_RESPONSE_MS,request.departureDateMax]);
            if (offer) {
              // INSERT trigger may cap the deadline during a rolling deployment.
              // Freeze the actual delivery deadline; receipts can add 40s only once.
              await manager.query('UPDATE trip_request_dispatch_offers SET "deliveryDeadlineAt"="expiresAt" WHERE id=$1', [offerId]);
              return { candidate, offerId, expiresAt: new Date(offer.expiresAt) };
            }
          }
          return null;
        })();
        if (!claimed) return { wait: Date.now() + 1000, reset: true };
        const { candidate, offerId, expiresAt: deadline } = claimed;
        const driverId = candidate.driverId;
        if (request.immediateDispatch && !candidate.existingTripId) await manager.query(`UPDATE driver_dispatch_presence SET "vehicleId" = $2, seats = $3 WHERE "driverId" = $1`,
          [driverId, candidate.vehicleId, candidate.seats]);
        const expiresAt = deadline.toISOString();
        await enqueueTransactionalNotification(manager, { eventKey: 'sequential-offer:' + offerId, userId: driverId,
          title: 'Nouvelle demande de trajet', body: request.departureLocation + ' → ' + request.arrivalLocation + '. Accepter ou refuser ?',
          data: { type: request.immediateDispatch && !candidate.existingTripId ? 'driver_dispatch_offer' : 'trip_request_nearby',
            ...(candidate.existingTripId ? { sharedTrip: true, existingTripId: candidate.existingTripId } : {}),
            ringAlert: 'nearby-request-v1', tripRequestId: id, offerId, driverId, passengerId: request.passengerId,
            role: 'driver', vehicleType: request.vehicleType, vehicleTypes: JSON.stringify(requestVehicleTypes(request)), expiresAt, alertExpiresAt: expiresAt,
            ...rideSpeechData({ departure: request.departureLocation, arrival: request.arrivalLocation,
              seats: request.numberOfSeats, departureAt: request.departureDateMin,
              pricePerSeat: request.maxPricePerSeat, priceKind: 'budget' }) } });
        return { offeredUntil: deadline.getTime(), driverId, reset: false };
      });
      // Start fresh push/realtime immediately after commit, before even one Redis round trip.
      if ('offeredUntil' in result) void this.notifications.dispatchUrgentNotifications()
        .catch(() => this.logger.warn('Queued request push deferred.'));
      selectedDriverId = result.driverId;
      resetQueue = result.reset;
      await this.cache(() => this.queue.schedule(id, result.offeredUntil ?? result.wait!), undefined);
      return 'offeredUntil' in result;
    } catch (error) {
      // SQL + its indexed recovery scan survive Redis eviction, timeout or a process restart.
      // Never bypass durable single-recipient constraints with a broad broadcast.
      const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'unknown');
      this.logger.warn('Request relay deferred id=' + id + ' code=' + code);
      // Retirement may already have committed. Keep a wake-up even when there
      // is no pending SQL invitation left for the expiration recovery scan.
      await this.cache(() => this.queue.schedule(id, Date.now() + 1000), undefined);
      return false;
    } finally {
      if (sqlFallback) this.sqlFallbackWorkers--;
      if (token) await this.queue.release(id, token, selectedDriverId, resetQueue)
        .catch(() => this.logger.warn('Request queue lease release deferred; lease expires automatically.'));
    }
  }
  @Cron('* * * * * *')
  async deadlines(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      // Start Redis independently, but process SQL expirations without waiting for its response.
      const dueRead = Date.now() < this.cacheUnavailableUntil ? Promise.resolve([] as string[])
        : this.queue.due(Date.now()).catch(() => {
          this.logger.warn('Redis request deadlines unavailable; checking SQL expirations.');
          return [] as string[];
        });
      const rows: { requestId: string }[] = await this.db.query(`SELECT "requestId" FROM (SELECT "requestId", "expiresAt" FROM trip_request_dispatch_offers
          WHERE sequential = true AND status = 'pending' AND "expiresAt" <= now()
          UNION ALL SELECT id AS "requestId", "targetDriverPriorityUntil" AS "expiresAt" FROM trip_requests
          WHERE "targetDriverPriorityUntil" IS NOT NULL AND "targetDriverPriorityUntil"<=now()
            AND status IN ('pending','offers_received') AND "selectedDriverId" IS NULL AND "tripId" IS NULL) deadlines
          ORDER BY "expiresAt", "requestId" LIMIT 50`).catch(() => {
            // An isolated failure of the recovery query must not discard an
            // already successful Redis read and stop every timed handoff.
            this.logger.warn('SQL request expiration scan deferred; processing Redis deadlines.');
            return [] as { requestId: string }[];
          });
      const expired = new Set(rows.map(row => row.requestId));
      const drain = async (ids: string[]) => {
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
          while (cursor < ids.length) await this.advance(ids[cursor++]);
        }));
      };
      await drain([...expired]);
      await drain((await dueRead).filter(id => !expired.has(id)));
    } catch { this.logger.warn('Request deadline scan deferred.'); }
    finally { this.ticking = false; }
  }
}
