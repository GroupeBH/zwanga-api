import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { BookingsService } from '../bookings/bookings.service';
import { TrackingGateway } from './tracking.gateway';
import {
  claimRideProgress,
  finishRideProgress,
  RideProgressJob,
} from './ride-progress-queue';

@Injectable()
export class RideProgressWorker implements OnModuleDestroy {
  private readonly logger = new Logger(RideProgressWorker.name);
  private readonly active = new Set<Promise<void>>();
  private claiming = false;
  private claimInFlight?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly db: DataSource,
    private readonly bookings: BookingsService,
    private readonly gateway: TrackingGateway,
  ) {}

  @Cron('* * * * * *')
  tick(): Promise<void> {
    if (this.stopping || this.claiming || this.active.size >= 4)
      return Promise.resolve();
    this.claiming = true;
    this.claimInFlight = this.claim();
    return this.claimInFlight;
  }

  private async claim() {
    try {
      const jobs = await claimRideProgress(this.db, 4 - this.active.size);
      for (const job of jobs) {
        const work = this.process(job).catch(() =>
          this.logger.warn('Ride progress deferred to durable recovery.'),
        );
        this.active.add(work);
        void work.then(() => {
          this.active.delete(work);
          // Drain a backlog at bounded concurrency, rather than only four jobs per second.
          if (!this.stopping) void this.tick();
        });
      }
    } catch {
      this.logger.warn('Ride progress claim failed; pending work retained.');
    } finally {
      this.claiming = false;
    }
  }

  private async process(job: RideProgressJob) {
    let failed = true;
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
        { checkProximity: true },
      );
      await renewal;
      if (lostLease) throw new Error('Ride progress lease lost');
      this.gateway.publishAutomaticProgress(result);
      failed = false;
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await finishRideProgress(this.db, job, failed);
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.claimInFlight;
    await Promise.allSettled([...this.active]);
  }
}
