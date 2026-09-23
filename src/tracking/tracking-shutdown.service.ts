import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { TrackingGateway } from './tracking.gateway';

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

@Injectable()
export class TrackingShutdownService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(TrackingShutdownService.name);
  private shuttingDown = false;

  constructor(private readonly trackingGateway: TrackingGateway) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    const server = this.trackingGateway.server;
    if (!server) {
      return;
    }

    this.logger.warn(
      `Socket.IO tracking shutdown started${signal ? ` (${signal})` : ''}`,
    );

    server.use((_socket, next) => {
      next(new Error('server_restarting'));
    });

    server.emit('server_restart', {
      reason: 'deployment',
      reconnect: true,
      retryAfterSeconds: 10,
    });

    await delay(10_000);
    server.disconnectSockets(true);
    this.logger.warn('Socket.IO tracking shutdown completed');
  }

  onApplicationShutdown(): void {
    // The warning and disconnection happen in beforeApplicationShutdown(), while
    // Socket.IO is still available. This hook is intentionally kept as a marker
    // for Nest's shutdown lifecycle.
  }
}
