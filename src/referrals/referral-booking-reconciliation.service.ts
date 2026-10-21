import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { ReferralsService } from './referrals.service';

@Injectable()
export class ReferralBookingReconciliationService {
  private readonly logger = new Logger(ReferralBookingReconciliationService.name);
  constructor(private readonly source: DataSource, private readonly referrals: ReferralsService) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async reconcile(): Promise<void> {
    const lease = randomUUID();
    const [jobs]: [Array<{ bookingId: string; attempts: number; revision: number }>, number] = await this.source.query(`
      WITH due AS (SELECT "bookingId" FROM referral_booking_jobs
        WHERE "completedAt" IS NULL AND "nextAttemptAt" <= now()
          AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
        ORDER BY "nextAttemptAt", "bookingId" LIMIT 25 FOR UPDATE SKIP LOCKED)
      UPDATE referral_booking_jobs j SET "leaseToken" = $1, "leaseUntil" = now() + interval '5 minutes', attempts = j.attempts + 1
      FROM due WHERE j."bookingId" = due."bookingId" RETURNING j."bookingId", j.attempts, j.revision`, [lease]);
    for (const job of jobs) {
      let completed = false;
      try {
        const booking = await this.source.getRepository(Booking).findOneByOrFail({ id: job.bookingId });
        await this.referrals.awardBookingReward(booking);
        completed = true; // Includes ineligible bookings; never invent a credit.
      } catch {
        this.logger.warn(`REFERRAL_BOOKING_RECOVERY_PENDING bookingId=${job.bookingId} attempt=${job.attempts}`);
      }
      try {
        await this.source.query(`UPDATE referral_booking_jobs SET
          "completedAt" = CASE WHEN $3 AND revision = $4 THEN now() ELSE NULL END,
          "nextAttemptAt" = CASE WHEN revision <> $4 THEN LEAST("nextAttemptAt", now()) ELSE now() + $5::double precision * interval '1 second' END,
          "lastError" = CASE WHEN $3 THEN NULL ELSE 'REWARD_SETTLEMENT_FAILED' END,
          "leaseToken" = NULL, "leaseUntil" = NULL WHERE "bookingId" = $1 AND "leaseToken" = $2`,
          [job.bookingId, lease, completed, job.revision, Math.min(60 * 2 ** Math.min(job.attempts, 9), 21600)]);
      } catch {
        // A committed credit with a lost ACK is replayed after the lease; uniqueness protects it.
        this.logger.warn(`REFERRAL_BOOKING_ACK_PENDING bookingId=${job.bookingId}`);
      }
    }
  }
}
