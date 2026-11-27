import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AccountLifecycleService } from '../users/account-lifecycle.service';
import { UserStatus } from '../users/entities/user.entity';

@Injectable()
export class CashRestrictionRetirementService {
  private running = false;
  private readonly logger = new Logger(CashRestrictionRetirementService.name);
  constructor(
    private readonly db: DataSource,
    private readonly accounts: AccountLifecycleService,
  ) {}

  @Cron('*/30 * * * * *')
  async retireSettledAccounts() {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.db.query<{ driverId: string }[]>(`
        SELECT r."driverId" FROM driver_cash_restrictions r JOIN users u ON u.id=r."driverId"
        WHERE r."deactivatedAt" IS NULL AND u."isActive" AND u.status='active'
          AND NOT EXISTS(SELECT 1 FROM trips t WHERE t."driverId"=u.id AND t.status='ongoing')
          AND NOT EXISTS(SELECT 1 FROM bookings b JOIN trips t ON t.id=b."tripId"
            WHERE t."driverId"=u.id AND b.status='completed' AND (b."paymentAmount" IS NULL OR b."paymentAmount">0)
            AND CASE WHEN b."paymentMode"='cash' THEN b."cashReceivedAt" IS NULL
              ELSE b."paymentStatus" IS DISTINCT FROM 'succeeded' END)
        ORDER BY r."restrictedAt",r."driverId" LIMIT 10`);
      for (const { driverId } of candidates) {
        try {
          // Existing lifecycle rechecks boarding under lock and preserves settled
          // financial history. New admissions are already blocked by DB triggers.
          await this.accounts.deactivate(
            driverId,
            UserStatus.SUSPENDED,
            async (manager) => {
              await manager.query(
                'UPDATE driver_cash_restrictions SET "deactivatedAt"=COALESCE("deactivatedAt",now()) WHERE "driverId"=$1',
                [driverId],
              );
            },
            async (manager) => {
              const [state] = await manager.query<{ busy: boolean }[]>(
                `SELECT EXISTS(SELECT 1 FROM trips WHERE "driverId"=$1 AND status='ongoing')
              OR EXISTS(SELECT 1 FROM bookings b JOIN trips t ON t.id=b."tripId"
                WHERE t."driverId"=$1 AND b.status='completed' AND (b."paymentAmount" IS NULL OR b."paymentAmount">0)
                AND CASE WHEN b."paymentMode"='cash' THEN b."cashReceivedAt" IS NULL
                  ELSE b."paymentStatus" IS DISTINCT FROM 'succeeded' END) AS busy`,
                [driverId],
              );
              if (!state || state.busy)
                throw new ConflictException(
                  'Terminez les courses et leur règlement avant la désactivation.',
                );
            },
          );
        } catch {
          // Busy/unclosed rides are retried. Never reveal account data or revoke
          // a session just to make this worker succeed.
          this.logger.warn(
            'Cash restriction retirement deferred; account lifecycle conditions not met.',
          );
        }
      }
    } catch {
      this.logger.warn('Cash restriction retirement unavailable; will retry.');
    } finally {
      this.running = false;
    }
  }
}
