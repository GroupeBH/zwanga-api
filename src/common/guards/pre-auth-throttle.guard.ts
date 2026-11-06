import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { RedisService } from '../services/redis.service';
import { RedisThrottlerStorage } from '../services/redis-throttler.storage';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { trustedProxyCidrs } from '../trusted-proxy';

/** Coarse limit before JWT/SQL. Per-user and endpoint quotas stay unchanged.
 * Explicit opt-in: enabling this behind an unconfigured ALB would share its IP
 * budget among all users. Never trust an arbitrary X-Forwarded-For header. */
@Injectable()
export class PreAuthThrottleGuard implements CanActivate {
  private readonly storage: RedisThrottlerStorage;
  private readonly limit: number;
  constructor(
    config: ConfigService,
    redis: RedisService,
    private readonly reflector: Reflector,
  ) {
    this.storage = new RedisThrottlerStorage(redis);
    this.limit = Number(config.get('PRE_AUTH_IP_LIMIT_PER_MINUTE') ?? 0);
    if (!Number.isSafeInteger(this.limit) || this.limit < 0)
      throw new Error(
        'PRE_AUTH_IP_LIMIT_PER_MINUTE must be a non-negative integer',
      );
    if (
      this.limit &&
      config.get('NODE_ENV') === 'production' &&
      !trustedProxyCidrs(config.get('TRUSTED_PROXY_CIDRS'))
    )
      throw new Error(
        'Configure TRUSTED_PROXY_CIDRS before enabling the production pre-auth limit',
      );
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.limit || context.getType() !== 'http') return true;
    // Public login/OTP already have IP/account quotas and never enter JWT's SQL
    // validation. Do not limit liveness probes or provider callbacks here.
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest();
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    const key = createHash('sha256').update(ip).digest('hex');
    const result = await this.storage.increment(`pre-auth:${key}`, 60_000);
    if (result.totalHits > this.limit) {
      context
        .switchToHttp()
        .getResponse()
        .setHeader('Retry-After', String(result.timeToExpire));
      throw new ThrottlerException();
    }
    return true;
  }
}
