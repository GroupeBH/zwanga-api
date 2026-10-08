import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { RedisHealthIndicator } from './redis.health-indicator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly source: DataSource,
  ) {}

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
          to_regprocedure('zwanga_cash_policy_enabled()') IS NOT NULL AS functions
          FROM financial_rollout WHERE id=true`);
      });
      if (schema?.contractVersion !== 1 || !schema.functions) throw new Error('schema');
    } catch { throw new ServiceUnavailableException('Le schéma financier du serveur n’est pas prêt.'); }

    return {
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      uptime: process.uptime(),
    };
  }
}
