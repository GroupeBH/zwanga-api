import { ConfigService } from '@nestjs/config';
import type { ServerOptions } from 'socket.io';

export function createOriginPolicy(config: ConfigService) {
  const origins = new Set(
    (config.get<string>('CORS_ORIGINS') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const production = config.get<string>('NODE_ENV') === 'production';
  // Preserve HTTP's local-development policy and native clients without Origin.
  return (origin: string | undefined): boolean =>
    !origin || !production || origins.has(origin);
}

export function createCorsOptions(config: ConfigService) {
  const allowed = createOriginPolicy(config);
  return {
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      callback(
        allowed(origin) ? null : new Error('Origin not allowed by CORS'),
        allowed(origin),
      );
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  };
}

export function createSocketOriginOptions(
  config: ConfigService,
): Partial<ServerOptions> {
  const allowed = createOriginPolicy(config);
  return {
    cors: createCorsOptions(config),
    // Browser WebSocket upgrades do not enforce CORS; check their Origin too.
    allowRequest: (request, callback) => {
      const accept = allowed(request.headers.origin);
      callback(accept ? null : 'Origin not allowed', accept);
    },
  };
}
