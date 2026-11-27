import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { BookingsService } from '../bookings/bookings.service';
import { TrackingGateway } from './tracking.gateway';
import { LocationHistoryPendingError } from '../common/services/location-history.service';
import { backgroundSql } from '../database/background-sql-budget';
import {
  claimRideProgress,
  finishAndClaimRideProgress,
  finishRideProgress,
  RideProgressJob,
} from './ride-progress-queue';

@Injectable()
export class RideProgressWorker implements OnModuleDestroy {
  private readonly logger = new Logger(RideProgressWorker.name);
  private readonly active = new Set<Promise<void>>();
  private claiming = false;
  private claimInFlight?: Promise<void>;
  private refill?: NodeJS.Immediate;
  private refillPending = false;
  private stopping = false;
  constructor(
    private readonly db: DataSource,
    private readonly bookings: BookingsService,
    private readonly gateway: TrackingGateway,
  ) {}

  @Cron('* * * * * *')
  tick(): Promise<void> {
    if (this.stopping || this.active.size >= 4)
      return Promise.resolve();
    if (this.claiming) {
      this.refillPending = true;
      return Promise.resolve();
    }
    if (this.refill) clearImmediate(this.refill);
    this.refill = undefined;
    this.refillPending = false;
    this.claiming = true;
    this.claimInFlight = this.claim();
    return this.claimInFlight;
  }

  private async claim() {
    try {
      const jobs = await backgroundSql(this.db, 'progress', () => claimRideProgress(this.db, 4 - this.active.size));
      for (const job of jobs) {
        const work = this.runSlot(job).catch(() =>
          this.logger.warn('Ride progress deferred to durable recovery.'),
        );
        this.active.add(work);
        void work.then(() => {
          this.active.delete(work);
          // Coalesce completions in the same event-loop turn into one SQL claim.
          // No pre-claimed in-memory backlog: claim only the four available slots.
          this.refillPending = true;
          this.scheduleRefill();
        });
      }
    } catch {
      this.logger.warn('Ride progress claim failed; pending work retained.');
    } finally {
      this.claiming = false;
      // A job can complete while a different refill is still waiting on SQL.
      this.scheduleRefill();
    }
  }

  private scheduleRefill() {
    if (this.stopping || this.claiming || !this.refillPending || this.refill || this.active.size >= 4) return;
    this.refill = setImmediate(() => {
      this.refill = undefined;
      void this.tick();
    });
    this.refill.unref();
  }

  private async runSlot(job: RideProgressJob) {
    let current: RideProgressJob | undefined = job;
    while (current) {
      current = await this.process(current);
      if (current && this.stopping) {
        // Shutdown can begin during the atomic handoff. Do not leave an unused
        // 90s lease behind, and never discard a job already claimed for us.
        const unprocessed = current;
        await backgroundSql(this.db, 'progress', () => finishRideProgress(this.db, unprocessed, true, 1000));
        return;
      }
    }
  }

  private async process(job: RideProgressJob): Promise<RideProgressJob | undefined> {
    let failed = true;
    let retryDelayMs: 1000 | 5000 = 5000;
    let lostLease = false;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.db
        .query(
          `WITH renewed AS (UPDATE ride_progress_jobs SET "leaseUntil"=clock_timestamp()+interval '90 seconds'
        WHERE "tripId"=$1 AND "leaseToken"=$2 RETURNING "tripId") SELECT "tripId" FROM renewed`,
          [job.tripId, job.leaseToken],
        )
        .then((rows) => {
          if (!rows.length) lostLease = true;
        })
        .catch(() => {
          lostLease = true;
          this.logger.warn('Ride progress lease renewal failed.');
        })
        .finally(() => {
          renewal = undefined;
        });
    }, 20_000);
    heartbeat.unref();
    try {
      const result = await this.bookings.evaluateAutomaticRideProgressForTrip(
        job.tripId,
        { checkProximity: true, requireRecordedHistory: true },
      );
      await renewal;
      if (lostLease) throw new Error('Ride progress lease lost');
      this.gateway.publishAutomaticProgress(result);
      failed = false;
    } catch (error) {
      if (error instanceof LocationHistoryPendingError) retryDelayMs = 1000;
      else this.logger.warn('Ride progress deferred to durable recovery.');
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
    if (this.stopping) {
      await backgroundSql(this.db, 'progress', () => finishRideProgress(this.db, job, failed, retryDelayMs));
      return undefined;
    }
    return backgroundSql(this.db, 'progress', () => finishAndClaimRideProgress(this.db, job, failed, retryDelayMs));
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.refillPending = false;
    if (this.refill) clearImmediate(this.refill);
    this.refill = undefined;
    await this.claimInFlight;
    await Promise.allSettled([...this.active]);
  }
}
