import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Socket } from 'socket.io';

const GPS_EVENTS = new Set([
  'driver_location_update',
  'passenger_location_update',
]);

const IMPORTANT_WS_EVENTS = new Set([
  'join_trip',
  'leave_trip',
  'resume_boarding_detection',
  'passenger_pickup_signal',
  'send_message',
  'join_booking',
]);

const DEFAULT_GPS_SAMPLE_RATE = 0.01;

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType<'http' | 'ws'>() === 'ws') {
      return this.interceptWebSocket(context, next);
    }

    const request = context.switchToHttp().getRequest();
    const { method, url, ip, headers } = request;
    const userAgent = headers['user-agent'] || '';
    const user = request.user;

    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: (data) => {
          const response = context.switchToHttp().getResponse();
          const { statusCode } = response;
          const responseTime = Date.now() - now;

          const logData = {
            method,
            url,
            statusCode,
            responseTime: `${responseTime}ms`,
            ip,
            userAgent,
            userId: user?.userId || 'anonymous',
          };

          if (statusCode >= 400) {
            this.logger.warn(`HTTP ${method} ${url}`, logData);
          } else {
            this.logger.log(`HTTP ${method} ${url}`, logData);
          }
        },
        error: (error) => {
          const responseTime = Date.now() - now;
          const logData = {
            method,
            url,
            statusCode: error.status || 500,
            responseTime: `${responseTime}ms`,
            ip,
            userAgent,
            userId: user?.userId || 'anonymous',
            error: error.message,
            stack: error.stack,
          };

          this.logger.error(`HTTP ${method} ${url}`, logData);
        },
      }),
    );
  }

  private interceptWebSocket(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<any> {
    const wsContext = context.switchToWs();
    const client = wsContext.getClient<Socket>();
    const data = wsContext.getData<Record<string, unknown> | undefined>();
    const event = wsContext.getPattern() as string | undefined;
    const now = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          if (!this.shouldLogSocketEvent(event)) {
            return;
          }

          this.logger.log('Socket.IO event handled', {
            event,
            namespace: client.nsp?.name,
            socketId: client.id,
            userId: client.data?.userId,
            tripId: this.extractTripId(data, client),
            bookingId:
              typeof data?.bookingId === 'string' ? data.bookingId : undefined,
            responseTime: `${Date.now() - now}ms`,
            sampled: event ? GPS_EVENTS.has(event) : false,
          });
        },
        error: (error) => {
          this.logger.error('Socket.IO event failed', {
            event,
            namespace: client.nsp?.name,
            socketId: client.id,
            userId: client.data?.userId,
            tripId: this.extractTripId(data, client),
            bookingId:
              typeof data?.bookingId === 'string' ? data.bookingId : undefined,
            responseTime: `${Date.now() - now}ms`,
            error: error.message,
            stack: error.stack,
          });
        },
      }),
    );
  }

  private shouldLogSocketEvent(event?: string): boolean {
    if (!event) {
      return false;
    }

    if (GPS_EVENTS.has(event)) {
      return Math.random() < this.getGpsSampleRate();
    }

    return IMPORTANT_WS_EVENTS.has(event);
  }

  private getGpsSampleRate(): number {
    const configuredRate = Number(process.env.GPS_LOG_SAMPLE_RATE ?? '');
    if (!Number.isFinite(configuredRate)) {
      return DEFAULT_GPS_SAMPLE_RATE;
    }

    return Math.min(Math.max(configuredRate, 0), 1);
  }

  private extractTripId(
    data: Record<string, unknown> | undefined,
    client: Socket,
  ): string | undefined {
    if (typeof data?.tripId === 'string') {
      return data.tripId;
    }

    if (typeof client.data?.tripId === 'string') {
      return client.data.tripId;
    }

    return undefined;
  }
}

