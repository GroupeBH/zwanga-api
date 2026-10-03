import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { ACCOUNT_THROTTLE_KEY } from '../decorators/account-throttle.decorator';

@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req.user?.userId?.trim();
    if (userId) return `user:${userId}`;
    // req.ip is resolved by Express using only explicitly trusted proxy addresses.
    return `ip:${req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown'}`;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    await super.canActivate(context);
    if (this.reflector.getAllAndOverride<boolean>(ACCOUNT_THROTTLE_KEY,
      [context.getHandler(), context.getClass()])) {
      const { req, res } = this.getRequestResponse(context);
      const phone = typeof req.body?.phone === 'string' ? req.body.phone.replace(/\D/g, '') : '';
      if (phone) {
        const fingerprint = createHash('sha256').update(phone).digest('hex');
        for (const [window, limit] of [[900_000, 20], [86_400_000, 60]]) {
          const count = await this.storageService.increment(`login:${window}:${fingerprint}`, window);
          if (count.totalHits > limit) {
            res.header('Retry-After', count.timeToExpire);
            throw new ThrottlerException('Trop de tentatives. Réessayez plus tard ou réinitialisez votre PIN.');
          }
        }
      }
    }
    return true;
  }
}
