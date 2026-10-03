import { Controller, Get } from '@nestjs/common';
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

    return {
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      uptime: process.uptime(),
    };
  }
}
