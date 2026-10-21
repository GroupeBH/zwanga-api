import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { PaymentsService } from './payments.service';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  constructor(
    private readonly source: DataSource,
    private readonly payments: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async reconcile(): Promise<void> {
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

    for (const job of jobs) {
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
        21_600,
      );
      // A callback received during settlement must not be acknowledged by stale work.
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
      if (
        !completed &&
        (errorCode ||
          Date.now() - new Date(job.createdAt).getTime() > 86_400_000)
      ) {
        this.logger.warn(
          `Payment reconciliation pending: paymentId=${job.paymentId}, attempt=${job.attempts}, reason=${errorCode ?? 'PROVIDER_PENDING'}`,
        );
      }
    }
  }
}
