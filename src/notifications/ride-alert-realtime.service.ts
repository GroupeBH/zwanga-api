import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { redisBroadcastReady } from '../common/resilient-redis.adapter';

/** Hints only; REST and its authenticated business checks remain authoritative.
 * Reuses /chat's server-owned user rooms and its configured cluster adapter. */
@Injectable()
export class RideAlertRealtime {
  private server?: Server;
  private readonly logger = new Logger(RideAlertRealtime.name);
  bind(server: Server) { this.server = server; }
  isBound() { return Boolean(this.server); }

  publish(userId: string, event: Record<string, unknown>) {
    if (!userId || !this.server) return false;
    try {
      // Gate Redis namespaces, while retaining the in-memory adapter used by
      // isolated tests. No mutation of user rooms or authorization checks.
      if (!redisBroadcastReady(this.server.adapter)) return false;
      this.server.to(`user:${userId}`).emit('ride_alert', { ...event, recipientId: userId });
      return true;
    } catch {
      // Socket delivery must never turn a committed acceptance into an HTTP error.
      this.logger.warn('Ride realtime hint unavailable; push/REST remain available.');
      return false;
    }
  }
}
