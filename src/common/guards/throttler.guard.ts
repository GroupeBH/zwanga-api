import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';

@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const request = req as Request;

    if (!request) {
      return super.getTracker(req);
    }

    const headerIp = this.extractFromHeaders(request);
    if (headerIp) {
      return headerIp;
    }

    if (request.ips && request.ips.length > 0) {
      return request.ips[0];
    }

    if (request.ip) {
      return request.ip;
    }

    const connectionIp =
      request.connection?.remoteAddress || request.socket?.remoteAddress;
    if (connectionIp) {
      return connectionIp;
    }

    return 'unknown';
  }

  private extractFromHeaders(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0].split(',')[0].trim();
    }
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }

    const realIp = req.headers['x-real-ip'];
    if (Array.isArray(realIp) && realIp.length > 0) {
      return realIp[0];
    }
    if (typeof realIp === 'string' && realIp.length > 0) {
      return realIp;
    }

    return undefined;
  }
}

