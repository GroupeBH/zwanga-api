import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExecutionContext,
  HttpException,
  ValidationPipe,
  WsExceptionFilter,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import type { Socket } from 'socket.io';

function socketSession(client: Socket): Record<string, unknown> {
  return client.data as Record<string, unknown>;
}

export function socketUserId(client: Socket): string {
  const userId = socketSession(client).userId;
  if (typeof userId !== 'string' || !userId) {
    throw new WsException('Authentification requise.');
  }
  return userId;
}

export class WsAuthenticatedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    socketUserId(client);
    const expiresAt = socketSession(client).authExpiresAt;
    if (
      typeof expiresAt !== 'number' ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      throw new WsException('Session expirée. Veuillez vous reconnecter.');
    }
    return true;
  }
}

export function createWsValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: () => new WsException('Données WebSocket invalides.'),
  });
}

export function emitSocketError(client: Socket, error: unknown): void {
  let message = 'Impossible de traiter cette demande.';
  if (error instanceof WsException && typeof error.getError() === 'string') {
    message = error.getError() as string;
  } else if (error instanceof HttpException && error.getStatus() < 500) {
    message = error.message;
  }
  // Keep the mobile client's existing error event, without exposing internal errors.
  client.emit('error', { message });
}

@Catch()
export class WsErrorFilter implements WsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    emitSocketError(host.switchToWs().getClient<Socket>(), exception);
  }
}

export async function authenticateSocket(
  client: Socket,
  jwtService: JwtService,
  configService: ConfigService,
): Promise<boolean> {
  const session = socketSession(client);
  delete session.userId;
  delete session.authExpiresAt;
  try {
    const authToken: unknown = client.handshake.auth?.token;
    const header = client.handshake.headers.authorization;
    const token =
      authToken ??
      (typeof header === 'string'
        ? /^Bearer\s+(\S+)$/i.exec(header)?.[1]
        : undefined);
    if (typeof token !== 'string' || !token) {
      throw new WsException('Authentification requise.');
    }
    const payload = await jwtService.verifyAsync<{
      sub?: unknown;
      exp?: unknown;
    }>(token, {
      secret: configService.get<string>('JWT_SECRET'),
    });
    if (
      typeof payload.sub !== 'string' ||
      !isUUID(payload.sub) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      payload.exp * 1000 <= Date.now()
    ) {
      throw new WsException('Authentification requise.');
    }
    session.userId = payload.sub;
    session.authExpiresAt = payload.exp * 1000;
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}
