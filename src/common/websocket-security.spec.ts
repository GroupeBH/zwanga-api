import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import {
  authenticateSocket,
  createWsValidationPipe,
  emitSocketError,
  WsAuthenticatedGuard,
} from './websocket-security';
import { createOriginPolicy, createSocketOriginOptions } from './cors-policy';
import {
  BookingChatSocketDto,
  SendChatSocketMessageDto,
} from '../chat/dto/chat-socket.dto';
import {
  DriverLocationSocketDto,
  PassengerLocationSocketDto,
} from '../tracking/dto/tracking-socket.dto';
import type { IncomingMessage } from 'http';

const id = '00000000-0000-4000-8000-000000000001';
const config = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

describe('WebSocket payload validation', () => {
  const pipe = createWsValidationPipe();
  it.each([
    null,
    {},
    [],
    { bookingId: 'bad' },
    { bookingId: [id] },
    { bookingId: id, userId: id },
  ])('rejects malformed booking payload %j', async (body) => {
    await expect(
      pipe.transform(body, { type: 'body', metatype: BookingChatSocketDto }),
    ).rejects.toBeInstanceOf(WsException);
  });
  it.each(['', '   ', 123, 'x'.repeat(4001)])(
    'rejects invalid message content',
    async (content) => {
      await expect(
        pipe.transform(
          { bookingId: id, content },
          { type: 'body', metatype: SendChatSocketMessageDto },
        ),
      ).rejects.toBeInstanceOf(WsException);
    },
  );
  it.each([
    [15.3],
    [15.3, -4.3, 1],
    ['15.3', '-4.3'],
    [NaN, 0],
    [Infinity, 0],
    [200, 0],
  ])('rejects invalid coordinate pair %j', async (...coordinates) => {
    await expect(
      pipe.transform(
        { tripId: id, coordinates },
        { type: 'body', metatype: DriverLocationSocketDto },
      ),
    ).rejects.toBeInstanceOf(WsException);
  });
  it('preserves valid mobile GPS payloads and requires a passenger booking ID', async () => {
    const data = {
      tripId: id,
      coordinates: [15.3, -4.3],
      speed: -1,
      accuracy: null,
      recordedAt: '2026-09-17T10:00:00.000Z',
    };
    await expect(
      pipe.transform(data, { type: 'body', metatype: DriverLocationSocketDto }),
    ).resolves.toMatchObject(data);
    await expect(
      pipe.transform(data, {
        type: 'body',
        metatype: PassengerLocationSocketDto,
      }),
    ).rejects.toBeInstanceOf(WsException);
  });
});

describe('WebSocket authentication and safe errors', () => {
  const jwt = new JwtService({ secret: 'test-socket-secret' });
  const settings = config({ JWT_SECRET: 'test-socket-secret' });
  const client = (token?: unknown) => ({
    handshake: { auth: { token }, headers: {} },
    data: {},
    disconnect: jest.fn(),
    emit: jest.fn(),
  });
  it('accepts a signed token with a valid identity and expiration', async () => {
    const socket = client(jwt.sign({ sub: id }, { expiresIn: '1h' }));
    expect(
      await authenticateSocket(socket as unknown as Socket, jwt, settings),
    ).toBe(true);
    expect(socket.data).toMatchObject({ userId: id });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, 'bad-token'])(
    'disconnects invalid credentials without setting an identity',
    async (token) => {
      const socket = client(token);
      expect(
        await authenticateSocket(socket as unknown as Socket, jwt, settings),
      ).toBe(false);
      expect(socket.data).not.toHaveProperty('userId');
      expect(socket.disconnect).toHaveBeenCalled();
    },
  );
  it('rejects events before asynchronous authentication finishes or after expiry', () => {
    const guard = new WsAuthenticatedGuard();
    for (const data of [
      {},
      { userId: id },
      { userId: id, authExpiresAt: Date.now() - 1 },
    ]) {
      const context = {
        switchToWs: () => ({ getClient: () => ({ data }) }),
      } as unknown as ExecutionContext;
      expect(() => guard.canActivate(context)).toThrow(WsException);
    }
  });
  it('hides internal exception details while keeping the mobile error event', () => {
    const socket = client();
    emitSocketError(
      socket as unknown as Socket,
      new Error('private SQL details'),
    );
    expect(socket.emit).toHaveBeenLastCalledWith('error', {
      message: 'Impossible de traiter cette demande.',
    });
    emitSocketError(
      socket as unknown as Socket,
      new ForbiddenException('Accès refusé.'),
    );
    expect(socket.emit).toHaveBeenLastCalledWith('error', {
      message: 'Accès refusé.',
    });
  });
});

describe('Shared HTTP and Socket.IO origin policy', () => {
  it('uses an exact production allowlist while accepting native clients without Origin', () => {
    const policy = createOriginPolicy(
      config({
        NODE_ENV: 'production',
        CORS_ORIGINS: ' https://app.example.test,https://admin.example.test ',
      }),
    );
    expect(policy(undefined)).toBe(true);
    expect(policy('https://app.example.test')).toBe(true);
    expect(policy('https://app.example.test.attacker.test')).toBe(false);
    expect(policy('null')).toBe(false);
    expect(
      createOriginPolicy(config({ NODE_ENV: 'production' }))(
        'https://app.example.test',
      ),
    ).toBe(false);
  });
  it('enforces the same rule on direct WebSocket upgrades, not just polling CORS', () => {
    const options = createSocketOriginOptions(
      config({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.test',
      }),
    );
    const callback = jest.fn();
    options.allowRequest!(
      { headers: { origin: 'https://attacker.test' } } as IncomingMessage,
      callback,
    );
    expect(callback).toHaveBeenCalledWith('Origin not allowed', false);
    options.allowRequest!({ headers: {} } as IncomingMessage, callback);
    expect(callback).toHaveBeenLastCalledWith(null, true);
  });
});
