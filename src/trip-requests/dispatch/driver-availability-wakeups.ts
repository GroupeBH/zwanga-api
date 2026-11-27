import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestDriverQueue } from './request-driver-queue';
import { REQUEST_DISPATCH_PRIORITY_SQL } from './dispatch-scheduling-policy';
import { NEARBY_DRIVER_RADIUS_METERS } from './nearby-driver-policy';
import { ONGOING_DRIVER_POSITION_SQL, USABLE_DRIVER_LOCATION_SQL } from './driver-location-policy';
import { backgroundSql } from '../../database/background-sql-budget';

/** Availability events are hints, never authorisations. All eligibility,
 * exclusivity and response-window checks stay in the SQL relay. No network/SQL
 * hint work is called until the originating business transaction has committed. */
@Injectable()
export class DriverAvailabilityWakeups implements OnModuleDestroy {
  private readonly logger = new Logger(DriverAvailabilityWakeups.name);
  private handler?: (id: string) => Promise<boolean>;
  private ready = new Set<string>();
  private workers = 0;
  private selections = 0;
  private requestReads = 0;
  private stopped = false;
  private unavailableUntil = 0;
  constructor(private readonly db: DataSource, private readonly queue: RequestDriverQueue) {}
  bind(handler: (id: string) => Promise<boolean>) { this.handler = handler; }
  onModuleDestroy() { this.stopped = true; this.ready.clear(); }

  async requestReleased(id: string): Promise<boolean> {
    if (this.stopped || this.requestReads >= 2 || Date.now() < this.unavailableUntil) return false;
    this.requestReads++;
    try {
      // Includes losers cancelled directly by the acceptance/cancellation flow.
      const rows: { driverId: string }[] = await backgroundSql(this.db, 'maintenance', () => this.db.query(`SELECT "driverId"
        FROM trip_request_dispatch_offers WHERE "requestId"=$1 AND status<>'pending'
        ORDER BY "createdAt" DESC, id LIMIT 4`, [id]));
      return await this.driversAvailable(rows.map(row => row.driverId), id);
    } catch { this.deferred(); return false; }
    finally { this.requestReads--; }
  }

  async driversAvailable(ids: string[], exceptRequestId: string | null = null): Promise<boolean> {
    if (this.stopped || !this.handler || this.selections >= 2 || Date.now() < this.unavailableUntil) return false;
    this.selections++;
    try {
      const selected = await this.queue.claimAvailabilityMany(ids);
      if (!selected.length) return false;
      const rows: { id: string }[] = await backgroundSql(this.db, 'maintenance', () => this.db.transaction(async manager => {
        await manager.query("SET LOCAL statement_timeout = '1s'");
        return manager.query(`WITH locations AS MATERIALIZED (
          SELECT p."driverId", v.id AS "vehicleId", p.position
          FROM driver_dispatch_presence p JOIN vehicles v ON v."ownerId"=p."driverId" AND v."isActive"=true
          WHERE p."driverId"=ANY($1::uuid[])
            AND ${USABLE_DRIVER_LOCATION_SQL}
          UNION ALL
          SELECT t."driverId", t."vehicleId"::uuid, ${ONGOING_DRIVER_POSITION_SQL}
          FROM trips t LEFT JOIN driver_dispatch_presence p ON p."driverId"=t."driverId"
          WHERE t."driverId"=ANY($1::uuid[]) AND t.status='ongoing'
        ), matches AS (
          SELECT candidate.* FROM locations l JOIN vehicles v ON v.id=l."vehicleId" AND v."isActive"=true
          CROSS JOIN LATERAL (
            SELECT r.id, ${REQUEST_DISPATCH_PRIORITY_SQL} AS priority FROM trip_requests r
            WHERE r.status IN ('pending','offers_received') AND r."departureDateMax">now()
              AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL
              AND r."passengerId"<>l."driverId"
              AND (r."immediateDispatch"=false OR r."maxPricePerSeat" IS NOT NULL)
              AND ($2::uuid IS NULL OR r.id<>$2::uuid)
              AND (r."targetDriverId" IS NULL OR r."targetDriverId"=l."driverId")
              AND (r."targetDriverPriorityUntil" IS NULL OR r."targetDriverPriorityUntil"<=now())
              AND v.type::text=ANY(COALESCE(r."vehicleTypes", ARRAY[r."vehicleType"::text]))
              AND ST_DWithin(r."departurePoint", l.position, $3)
              AND NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers o
                WHERE o."requestId"=r.id AND (o.status='pending' OR o."driverId"=l."driverId"))
            ORDER BY priority, r.id LIMIT 4
          ) candidate
          WHERE NOT EXISTS (SELECT 1 FROM trip_request_dispatch_offers busy
            WHERE busy."driverId"=l."driverId" AND busy.status='pending')
        ) SELECT id FROM matches GROUP BY id ORDER BY min(priority), id LIMIT $4`,
        [selected, exceptRequestId, NEARBY_DRIVER_RADIUS_METERS, Math.min(4, selected.length)]);
      }));
      let woke = false;
      for (const row of rows) {
        if (this.ready.size >= 200) break;
        if (await this.queue.wake(row.id)) { this.ready.add(row.id); woke = true; }
      }
      this.drain();
      return woke;
    } catch { this.deferred(); return false; }
    finally { this.selections--; }
  }
  private deferred() {
    this.unavailableUntil = Date.now() + 5000;
    this.logger.warn('Availability hints deferred; durable dispatch cron remains active.');
  }
  private drain() {
    while (!this.stopped && this.handler && this.workers < 2 && this.ready.size) {
      const id = this.ready.values().next().value!;
      this.ready.delete(id); this.workers++;
      void this.handler(id).catch(() => this.deferred()).finally(() => { this.workers--; this.drain(); });
    }
  }
}
