import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
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
}

