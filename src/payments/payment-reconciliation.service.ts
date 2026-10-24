import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { PaymentsService } from './payments.service';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private running = false;
  constructor(
    private readonly source: DataSource,
    private readonly payments: PaymentsService,
  ) {}

  @Cron('*/10 * * * * *', { waitForCompletion: true })
  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runBatch();
    } finally {
      this.running = false;
    }
  }

  private async runBatch(): Promise<void> {
    const lease = randomUUID();
    // Claim in one short statement; never hold DB locks during a provider call.
    // TypeORM's PostgreSQL UPDATE result is [returnedRows, affectedRowCount].
    const [jobs]: [
      Array<{
        paymentId: string;
        attempts: number;
        revision: number;
        createdAt: Date;
      }>,
      number,
    ] = await this.source.query(
      `
      WITH due AS (
        SELECT "paymentId" FROM payment_settlement_jobs
        WHERE "completedAt" IS NULL AND "nextAttemptAt" <= now()
          AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
        ORDER BY "nextAttemptAt", "paymentId" LIMIT 5 FOR UPDATE SKIP LOCKED
      )
      UPDATE payment_settlement_jobs j SET "leaseToken" = $1,
        "leaseUntil" = now() + interval '15 minutes', attempts = j.attempts + 1
      FROM due WHERE j."paymentId" = due."paymentId"
      RETURNING j."paymentId", j.attempts, j.revision, j."createdAt"`,
      [lease],
    );

    // Two independent lanes keep a slow provider from serialising the batch.
    // Five claims per ten seconds bound provider traffic and DB pool usage.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, jobs.length) }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          let completed = false;
          let errorCode: string | null = null;
          try {
            completed = await this.payments.reconcilePayment(job.paymentId);
          } catch {
            // Provider bodies can contain personal data: do not persist/log them here.
            errorCode = 'VERIFICATION_OR_SETTLEMENT_FAILED';
          }
          const delaySeconds = Math.min(
            60 * 2 ** Math.min(job.attempts, 9),
            900,
          );
          // A callback received during settlement must not be acknowledged by stale work.
          try {
            await this.source.query(
              `UPDATE payment_settlement_jobs SET
        "completedAt" = CASE WHEN $3 AND revision = $6 THEN now() ELSE NULL END,
        "nextAttemptAt" = CASE WHEN revision <> $6 THEN LEAST("nextAttemptAt", now() + interval '1 minute')
          ELSE now() + $4::double precision * interval '1 second' END,
        "lastError" = CASE WHEN revision = $6 THEN $5 ELSE NULL END,
        "leaseToken" = NULL, "leaseUntil" = NULL
        WHERE "paymentId" = $1 AND "leaseToken" = $2`,
              [
                job.paymentId,
                lease,
                completed,
                delaySeconds,
                errorCode,
                job.revision,
              ],
            );
          } catch {
            // Other claimed jobs must still run. This lease expires for safe retry.
            this.logger.warn(
              `Payment recovery acknowledgement deferred: paymentId=${job.paymentId}`,
            );
          }
          if (
            !completed &&
            (errorCode ||
              Date.now() - new Date(job.createdAt).getTime() > 900_000)
          ) {
            this.logger.warn(
              `Payment reconciliation pending: paymentId=${job.paymentId}, attempt=${job.attempts}, reason=${errorCode ?? 'PROVIDER_PENDING'}`,
            );
          }
        }
      }),
    );
  }
}
