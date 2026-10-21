import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { RedisHealthIndicator } from './redis.health-indicator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { SkipThrottle } from '@nestjs/throttler';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly source: DataSource,
  ) {}

  // Liveness must not restart workers during a shared database/Redis outage.
  @Get('live')
  @Public()
  @SkipThrottle()
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  @Get()
  @Public()
  @SensitiveThrottle(120, 60000)
  @HealthCheck({ swaggerDocumentation: false })
  async check() {
    await this.health.check([
      () => this.db.pingCheck('db', { timeout: 1_500 }),
      () => this.redis.pingCheck('redis', 1_500),
    ]);

    try {
      // Readiness, not merely a successful SELECT 1: refuse traffic on an old schema.
      const [schema] = await this.source.transaction(async manager => {
        await manager.query(`SET LOCAL statement_timeout = '1500ms'`);
        return manager.query(`SELECT "contractVersion", enabled,
          to_regprocedure('zwanga_cash_policy_enabled()') IS NOT NULL AS functions,
          to_regclass('payment_settlement_jobs') IS NOT NULL
            AND to_regprocedure('zwanga_guard_referral_payout_submission()') IS NOT NULL AS recovery,
          to_regclass('referral_booking_jobs') IS NOT NULL
            AND to_regclass('"IDX_referral_withdrawal_intent"') IS NOT NULL
            AND to_regprocedure('zwanga_queue_booking_referral()') IS NOT NULL AS referrals
          FROM financial_rollout WHERE id=true`);
      });
      if (schema?.contractVersion !== 1 || !schema.functions || !schema.recovery || !schema.referrals) throw new Error('schema');
    } catch { throw new ServiceUnavailableException('Le schéma financier du serveur n’est pas prêt.'); }

    return {
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      uptime: process.uptime(),
    };
  }
}
