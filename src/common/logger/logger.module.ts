import { Module, Global } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';

@Global()
@Module({
  imports: [
    WinstonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const nodeEnv = configService.get<string>('NODE_ENV') || 'development';
        const logDir = configService.get<string>('LOG_DIR') || './logs';

        return {
          level: nodeEnv === 'production' ? 'info' : 'debug',
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.splat(),
            winston.format.json(),
          ),
          defaultMeta: { service: 'zwanga-backend' },
          transports: [
            // Console transport
            new winston.transports.Console({
              format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(
                  ({ timestamp, level, message, context, ...meta }) => {
                    const contextStr = context ? `[${context}]` : '';
                    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
                    return `${timestamp} ${level} ${contextStr} ${message} ${metaStr}`;
                  },
                ),
              ),
            }),
            // File transport for errors
            new winston.transports.File({
              filename: join(logDir, 'error.log'),
              level: 'error',
              maxsize: 5242880, // 5MB
              maxFiles: 5,
            }),
            // File transport for all logs
            new winston.transports.File({
              filename: join(logDir, 'combined.log'),
              maxsize: 5242880, // 5MB
              maxFiles: 5,
            }),
          ],
          exceptionHandlers: [
            new winston.transports.File({
              filename: join(logDir, 'exceptions.log'),
            }),
          ],
          rejectionHandlers: [
            new winston.transports.File({
              filename: join(logDir, 'rejections.log'),
            }),
          ],
        };
      },
    }),
  ],
  exports: [WinstonModule],
})
export class LoggerModule {}

