import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

/** Driver-first catch-up for eligible accounts; shares the original one-time grant. */
@Injectable()
export class WelcomeBonusService {
  private readonly logger = new Logger(WelcomeBonusService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'welcome-bonus-catch-up',
    waitForCompletion: true,
  })
  async backfillEligibleAccounts(): Promise<void> {
    try {
      const credited = await this.dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL lock_timeout = '2s'`);
        await manager.query(`SET LOCAL statement_timeout = '15s'`);
        const [result] = await manager.query<{ credited: number }[]>(
          'SELECT zwanga_backfill_welcome_bonus($1) AS credited',
          [100],
        );
        return result.credited;
      });
      if (credited > 0)
        this.logger.log(`Welcome bonus: ${credited} accounts credited`);
    } catch (error: unknown) {
      // The transaction rolled back; retry on the next tick without duplicate credits.
      this.logger.error(
        'Welcome bonus catch-up failed; next batch will retry',
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }
}
