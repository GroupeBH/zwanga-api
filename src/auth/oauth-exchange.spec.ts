import {
  ExecutionContext,
  INestApplication,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RedisService } from '../common/services/redis.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthExchangeService } from './oauth-exchange.service';

const tokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
};

function buildService(
  settings: Record<string, string> = {
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://frontend.example.test',
  },
) {
  const getConfig = jest.fn((name: string) => settings[name]);
  const config = { get: getConfig } as unknown as ConfigService;
  const records = new Map<string, { value: string; expiresAt: number }>();
  const client = {
    setEx: jest.fn((key: string, ttl: number, value: string) => {
      records.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return Promise.resolve('OK');
    }),
    // Emulate the single-command Redis operation, without connecting to a real server.
    getDel: jest.fn((key: string) => {
      const record = records.get(key);
      records.delete(key);
      return Promise.resolve(
        record && record.expiresAt > Date.now() ? record.value : null,
      );
    }),
  };
  const redis = new RedisService(config);
  Object.assign(redis, { client });
  return {
    service: new OAuthExchangeService(redis, config),
    redis,
    config,
    getConfig,
    client,
    records,
    settings,
  };
}

describe('OAuth exchange codes', () => {
  afterEach(() => jest.useRealTimers());

  it('issues unique opaque codes and stores tokens for exactly 60 seconds under a hashed key', async () => {
    const { service, client, records } = buildService();
    const code = await service.createCode(tokens);
    const otherCode = await service.createCode(tokens);
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    expect(otherCode).not.toBe(code);
    const key = `auth:oauth-exchange:${createHash('sha256').update(code).digest('hex')}`;
    expect(client.setEx).toHaveBeenCalledWith(key, 60, JSON.stringify(tokens));
    expect(JSON.stringify([...records])).not.toContain(code);
  });

  it('returns tokens once and rejects replay', async () => {
    const { service, client } = buildService();
    const code = await service.createCode(tokens);
    await expect(service.exchange(code)).resolves.toEqual(tokens);
    await expect(service.exchange(code)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(client.getDel).toHaveBeenCalledTimes(2);
  });

  it('allows only one simultaneous exchange across two backend instances', async () => {
    const { service, redis, config } = buildService();
    const otherInstance = new OAuthExchangeService(redis, config);
    const code = await service.createCode(tokens);
    const results = await Promise.allSettled([
      service.exchange(code),
      otherInstance.exchange(code),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('accepts a code before its deadline but rejects it at 60 seconds', async () => {
    jest.useFakeTimers();
    const { service } = buildService();
    const validCode = await service.createCode(tokens);
    const expiredCode = await service.createCode(tokens);
    jest.advanceTimersByTime(59_999);
    await expect(service.exchange(validCode)).resolves.toEqual(tokens);
    jest.advanceTimersByTime(1);
    await expect(service.exchange(expiredCode)).rejects.toThrow(
      'Code de connexion invalide ou expiré.',
    );
  });

  it('rejects an unknown well-formed code', async () => {
    const { service } = buildService();
    await expect(service.exchange('a'.repeat(64))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'G'.repeat(64),
    null,
    {},
    ['a'.repeat(64)],
  ])('rejects malformed input without consulting Redis: %j', async (code) => {
    const { service, client } = buildService();
    await expect(service.exchange(code as string)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(client.getDel).not.toHaveBeenCalled();
  });

  it('fails closed when Redis cannot store or consume a code', async () => {
    const { service, client } = buildService();
    client.setEx.mockRejectedValueOnce(new Error('sensitive-storage-error'));
    await expect(service.createCode(tokens)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    client.getDel.mockRejectedValueOnce(new Error('sensitive-storage-error'));
    await expect(service.exchange('a'.repeat(64))).rejects.toThrow(
      'La connexion est temporairement indisponible. Veuillez réessayer.',
    );
  });

  it('only returns the allowed token response fields', async () => {
    const { service } = buildService();
    const payload = {
      ...tokens,
      passwordChangeRequired: true,
      unexpected: 'private-data',
    };
    const code = await service.createCode(payload);
    await expect(service.exchange(code)).resolves.toEqual({
      ...tokens,
      passwordChangeRequired: true,
    });
  });

  it('uses ConfigService and preserves the configured frontend base path', () => {
    const { service, getConfig } = buildService({
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://frontend.example.test/app/',
    });
    expect(service.getFrontendCallbackUrl().toString()).toBe(
      'https://frontend.example.test/app/auth/callback',
    );
    expect(getConfig).toHaveBeenCalledWith('FRONTEND_URL');
  });

  it('allows the localhost fallback only outside production', () => {
    expect(
      buildService({ NODE_ENV: 'development' })
        .service.getFrontendCallbackUrl()
        .toString(),
    ).toBe('http://localhost:3000/auth/callback');
    expect(() =>
      buildService({ NODE_ENV: 'production' }).service.getFrontendCallbackUrl(),
    ).toThrow('Configuration FRONTEND_URL invalide.');
  });

  it.each([
    'not-an-url',
    '//example.test',
    'javascript:alert(1)',
    'http://example.test',
    'http://localhost:3000',
    'https://user:password@example.test',
    'https://example.test?redirect=elsewhere',
    'https://example.test#route',
  ])('rejects an unsafe production redirect target: %s', (frontendUrl) => {
    const { service } = buildService({
      NODE_ENV: 'production',
      FRONTEND_URL: frontendUrl,
    });
    expect(() => service.getFrontendCallbackUrl()).toThrow(
      'Configuration FRONTEND_URL invalide.',
    );
  });
});

describe('OAuth callback and exchange HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  let harness: ReturnType<typeof buildService>;
  const authService = {
    validateGoogleUser: jest.fn().mockResolvedValue(tokens),
  };

  beforeAll(async () => {
    harness = buildService();
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: OAuthExchangeService, useValue: harness.service },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    })
      .overrideGuard(AuthGuard('google'))
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<Request>();
          req.user = { googleId: 'verified-google-profile' };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.records.clear();
    harness.settings.FRONTEND_URL = 'https://frontend.example.test';
  });

  it('redirects with only a fragment code, then returns JWTs in a no-store POST response', async () => {
    const response = await request(server)
      .get('/auth/google/callback')
      .expect(302)
      .expect('Cache-Control', 'no-store')
      .expect('Referrer-Policy', 'no-referrer');
    const location = new URL(response.headers.location);
    expect(location.origin).toBe('https://frontend.example.test');
    expect(location.pathname).toBe('/auth/callback');
    expect(location.search).toBe('');
    const code = new URLSearchParams(location.hash.slice(1)).get('code');
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(response.headers)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(response.headers)).not.toContain(tokens.refreshToken);
    expect(response.text).not.toContain(tokens.accessToken);
    expect(response.text).not.toContain(tokens.refreshToken);
    await request(server)
      .post('/auth/exchange')
      .send({ code })
      .expect(200, tokens)
      .expect('Cache-Control', 'no-store')
      .expect('Pragma', 'no-cache');
    await request(server).post('/auth/exchange').send({ code }).expect(401);
  });

  it.each([
    {},
    { code: 'short' },
    { code: ['a'.repeat(64)] },
    { code: 123 },
    { code: 'a'.repeat(64), redirect: 'https://attacker.test' },
  ])('validates the exchange body: %j', async (body) => {
    await request(server).post('/auth/exchange').send(body).expect(400);
    expect(harness.client.getDel).not.toHaveBeenCalled();
  });

  it('requires the code in the POST body rather than the query string', async () => {
    const code = await harness.service.createCode(tokens);
    await request(server)
      .post(`/auth/exchange?code=${code}`)
      .send({})
      .expect(400);
    expect(harness.client.getDel).not.toHaveBeenCalled();
  });

  it('does not issue tokens or redirect when production FRONTEND_URL is missing', async () => {
    delete harness.settings.FRONTEND_URL;
    const response = await request(server)
      .get('/auth/google/callback')
      .expect(500);
    expect(response.headers.location).toBeUndefined();
    expect(authService.validateGoogleUser).not.toHaveBeenCalled();
    expect(harness.client.setEx).not.toHaveBeenCalled();
  });

  it('never falls back to a token-bearing redirect when Redis is unavailable', async () => {
    harness.client.setEx.mockRejectedValueOnce(
      new Error('sensitive-storage-error'),
    );
    const response = await request(server)
      .get('/auth/google/callback')
      .expect(503);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).not.toContain(tokens.accessToken);
    expect(response.text).not.toContain(tokens.refreshToken);
    expect(response.text).not.toContain('sensitive-storage-error');
  });
});
