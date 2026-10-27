import { BookingsService } from '../../bookings/bookings.service';
import { recoverRequestAcceptance } from './request-acceptance';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { TripRequest } from '../entities/trip-request.entity';
import { NotificationService } from '../../notifications/notifications.service';
import { RideAlertChanges } from '../../notifications/ride-alert-changes';
import { enqueueTransactionalNotification } from '../../notifications/transactional-notification';
import { rideSpeechData } from '../../notifications/ride-speech-data';
import { RequestDriverQueue } from './request-driver-queue';
import { sequentialCandidates } from './sequential-candidates';
import { REQUEST_RESPONSE_MS } from './sequential-policy';

@Injectable()
export class SequentialDispatchService {
  private readonly logger = new Logger(SequentialDispatchService.name);
  private ticking = false;
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
  private async provisionalTrip(manager: EntityManager, id: string) {
    const rows = await manager.query(`SELECT 1 FROM trips WHERE "tripRequestId" = $1
      AND status IN ('upcoming','ongoing','completed') LIMIT 1`, [id]);
    return rows.length > 0;
  }
  private async retire(manager: EntityManager, id: string, terminal: boolean) {
    // A counteroffer is a response, with its own passenger decision deadline.
    await manager.query(`UPDATE driver_offers d SET status='cancelled', "updatedAt"=clock_timestamp()
      WHERE d."tripRequestId"=$1 AND d.status='pending' AND ($2 OR EXISTS (
        SELECT 1 FROM trip_request_dispatch_offers o WHERE o."requestId"=$1 AND o."driverId"=d."driverId"
          AND o.status='pending' AND o.phase='passenger' AND o."expiresAt"<=clock_timestamp()))`, [id, terminal]);
    await manager.query(`UPDATE notifications n SET "isActive"=false
      WHERE n."isActive"=true AND n.data->>'type'='driver_offer'
        AND n.data->>'tripRequestId'=$1::text AND EXISTS (SELECT 1 FROM driver_offers d
          WHERE d."tripRequestId"=$1::uuid AND d.id::text=n.data->>'offerId' AND d.status IN ('cancelled','rejected'))`, [id]);
    const retired = await manager.query(`UPDATE trip_request_dispatch_offers SET status = $2
      WHERE "requestId" = $1 AND status = 'pending' AND ($3 OR "expiresAt" <= clock_timestamp()) RETURNING id`,
      [id, terminal ? 'cancelled' : 'expired', terminal]);
    await manager.query(`UPDATE notifications n SET "isActive" = false
      WHERE n."isActive" = true AND n.data ->> 'tripRequestId' = $1::text
        AND n.data ->> 'type' IN ('trip_request_nearby','driver_dispatch_offer','trip_request','new_trip_request')
        AND ($2 OR NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
          WHERE o."requestId" = $1::uuid AND o."driverId" = n."userId" AND o.status = 'pending' AND o."expiresAt" > now()))`, [id, terminal]);
    return retired[1] > 0;
  }
  /** Discovery ticks skip waiting offers without taking SQL row locks. Events bypass this cache. */
  async poll(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    try { return await this.queue.isDue(id) ? this.advance(id) : false; }
    catch { return false; }
  }
  /** Redis calls happen outside DB transactions. Request/presence locks fence stale Redis leases. */
  async advance(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    let token: string | null = null;
    try {
      token = await this.queue.lock(id);
      if (!token) return false;
      const state = await this.db.transaction(async manager => {
        const request = await this.lock(manager, id);
        if (request?.sequentialDispatch) {
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

        const changed = await this.retire(manager, id, false);
        const [pending] = await manager.query(`SELECT "expiresAt" FROM trip_request_dispatch_offers
          WHERE "requestId" = $1 AND status = 'pending' AND "expiresAt" > now() LIMIT 1`, [id]);
        return pending ? { wait: new Date(pending.expiresAt).getTime(), changed } : { request, changed };
      });
      if (!state || ('changed' in state && state.changed)) this.changes.enqueue({ kind: 'request', id, terminal: !state });
      if (!state) { await this.queue.close(id); return false; }
      if ('bookingId' in state) {
        if (!this.bookings) throw new Error('Booking recovery service unavailable');
        await this.bookings.acceptBooking(state.bookingId, state.driverId);
        await this.queue.schedule(id, Date.now() + 1000);
        return false; // Next pass finalizes under the request lock, even after process restart.
      }
      if ('wait' in state) { await this.queue.schedule(id, state.wait!); return false; }
      const candidates = await sequentialCandidates(this.db.manager, state.request);
      if (!await this.queue.replace(id, token, candidates.map(c => c.driverId),
          Math.ceil((state.request.departureDateMax.getTime() - Date.now()) / 1000))) return false;
      const driverId = await this.queue.take(id, token);
      if (!driverId) { await this.queue.schedule(id, Date.now() + 15_000); return false; }
      const result = await this.db.transaction(async manager => {
        const request = await this.lock(manager, id);
        if (!this.open(request) || await this.provisionalTrip(manager, id)) return null;
        const [pending] = await manager.query(`SELECT id FROM trip_request_dispatch_offers
          WHERE "requestId" = $1 AND status = 'pending'`, [id]);
        if (pending) return null;
        // Recheck eligibility, price and location after the Redis round trip, under SQL locks.
        const [candidate] = await sequentialCandidates(manager, request, driverId);
        if (!candidate) return null;
        const occupied = await manager.query(`SELECT id FROM trip_request_dispatch_offers
          WHERE "driverId" = $1 AND status = 'pending'`, [driverId]);
        if (occupied.length) return null;
        const offerId = randomUUID();
        const [offer] = await manager.query(`INSERT INTO trip_request_dispatch_offers
          (id,"requestId","driverId","vehicleId",seats,"expiresAt",sequential)
          VALUES ($1,$2,$3,$4,$5,LEAST(clock_timestamp() + $6 * interval '1 millisecond', $7),true)
          RETURNING "expiresAt"`, [offerId,id,driverId,candidate.vehicleId,candidate.seats,REQUEST_RESPONSE_MS,request.departureDateMax]);
        if (request.immediateDispatch) await manager.query(`UPDATE driver_dispatch_presence SET "vehicleId" = $2, seats = $3 WHERE "driverId" = $1`,
          [driverId, candidate.vehicleId, candidate.seats]);
        const expiresAt = new Date(offer.expiresAt).toISOString();
        await enqueueTransactionalNotification(manager, { eventKey: 'sequential-offer:' + offerId, userId: driverId,
          title: 'Nouvelle demande de trajet', body: request.departureLocation + ' → ' + request.arrivalLocation + '. Accepter ou refuser ?',
          data: { type: request.immediateDispatch ? 'driver_dispatch_offer' : 'trip_request_nearby',
            ringAlert: 'nearby-request-v1', tripRequestId: id, offerId, driverId, passengerId: request.passengerId,
            role: 'driver', vehicleType: request.vehicleType, expiresAt, alertExpiresAt: expiresAt,
            ...rideSpeechData({ departure: request.departureLocation, arrival: request.arrivalLocation,
              seats: request.numberOfSeats, departureAt: request.departureDateMin,
              pricePerSeat: request.maxPricePerSeat, priceKind: 'budget' }) } });
        return new Date(offer.expiresAt).getTime();
      });
      await this.queue.schedule(id, result ?? Date.now() + 1000);
      if (result) void this.notifications.dispatchUrgentNotifications().catch(() => this.logger.warn('Queued request push deferred.'));
      return result !== null;
    } catch (error) {
      // SQL + its indexed recovery scan survive Redis eviction, timeout or a process restart.
      // Never bypass the queue with a broad broadcast when Redis is unavailable.
      const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'unknown');
      this.logger.warn('Request relay deferred id=' + id + ' code=' + code); return false;
    } finally { if (token) await this.queue.unlock(id, token).catch(() => undefined); }
  }
  @Cron('* * * * * *')
  async deadlines(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      // Start both reads independently: Redis timeout must not prevent the SQL recovery scan.
      const [due, rows] = await Promise.all([
        this.queue.due(Date.now()).catch(() => [] as string[]),
        this.db.query(`SELECT "requestId" FROM trip_request_dispatch_offers
          WHERE sequential = true AND status = 'pending' AND "expiresAt" <= now()
          ORDER BY "expiresAt", id LIMIT 50`) as Promise<{ requestId: string }[]>,
      ]);
      const ids = [...new Set([...due, ...rows.map(row => row.requestId)])];
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
        while (cursor < ids.length) await this.advance(ids[cursor++]);
      }));
    } catch { this.logger.warn('Request deadline scan deferred.'); }
    finally { this.ticking = false; }
  }
}
