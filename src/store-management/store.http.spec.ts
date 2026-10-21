import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import {
  StoreAccess,
  StorePermissionsGuard,
  storePermissions,
  STORE_PROFILES,
} from './store.permissions';
import { StoreOperationsController } from './store-operations.controller';
import { StoreOperationsService } from './store-operations.service';
import { StoreAlertsService } from './store-alerts.service';
import { StoreExportsService } from './store-exports.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

describe('Store admin HTTP contracts, existing authentication and roles', () => {
  let app: INestApplication;
  const id = '10000000-0000-4000-8000-000000000001';
  const service = Object.fromEntries(
    [
      'status',
      'dashboard',
      'records',
      'metricCatalog',
      'metrics',
      'history',
      'alerts',
      'sync',
      'retry',
      'reply',
      'requestAnalytics',
    ].map((k) => [k, jest.fn(async () => ({ ok: true }))]),
  );
  const operations = Object.fromEntries(
    ['review', 'draft', 'submit', 'approve', 'publish', 'grant'].map((k) => [
      k,
      jest.fn(async () => ({ ok: true })),
    ]),
  );
  const access = {
    permissions: jest.fn(async (_id: string, role: string) =>
      storePermissions(role),
    ),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StoreController, StoreOperationsController],
      providers: [
        StorePermissionsGuard,
        { provide: StoreService, useValue: service },
        { provide: StoreAccess, useValue: access },
        { provide: StoreOperationsService, useValue: operations },
        { provide: StoreAlertsService, useValue: {} },
        { provide: StoreExportsService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(
      {
        canActivate(ctx) {
          const req = ctx.switchToHttp().getRequest();
          if (!req.headers['x-test-role']) throw new UnauthorizedException();
          req.user = {
            userId: id,
            role: req.headers['x-test-role'],
            passwordChangeRequired: req.headers['x-test-reset'] === 'true',
          };
          return true;
        },
      },
      new RolesGuard(new Reflector()),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    access.permissions.mockImplementation(async (_id, role) =>
      storePermissions(role),
    );
  });
  it('protects every endpoint from anonymous, mobile and marketer accounts', async () => {
    for (const [method, path] of [
      ['get', 'status'],
      ['get', 'dashboard'],
      ['get', 'records'],
      ['get', 'metrics/catalog'],
      ['get', 'metrics'],
      ['get', 'syncs'],
      ['get', 'alerts'],
      ['post', 'google/sync'],
      ['post', `syncs/${id}/retry`],
      ['post', `reviews/${id}/reply`],
      ['post', 'apple/analytics-request'],
      ['get', 'integrations'],
      ['get', 'integrations/google/status'],
      ['post', 'integrations/google/test'],
      ['get', 'overview'],
      ['get', 'analytics/google'],
      ['get', 'analytics/apple'],
      ['get', 'analytics/countries'],
      ['get', 'reviews'],
      ['get', `reviews/${id}`],
      ['post', `reviews/${id}/draft`],
      ['post', `reviews/${id}/submit`],
      ['post', `reviews/${id}/approve`],
      ['post', `reviews/${id}/publish`],
      ['post', `reviews/${id}/reconcile`],
      ['get', 'versions'],
      ['get', 'builds'],
      ['get', 'vitals'],
      ['get', 'vitals/errors'],
      ['get', `versions/${id}/incidents`],
      ['post', `versions/${id}/incidents`],
      ['post', `incidents/${id}/resolve`],
      ['get', 'access'],
      ['get', 'audit-logs'],
      ['get', 'alerts/rules'],
      ['get', 'alerts/events'],
      ['post', 'alerts/rules'],
      ['patch', `alerts/rules/${id}`],
      ['post', `alerts/events/${id}/acknowledge`],
      ['get', 'reports'],
      ['post', 'reports/export'],
      ['get', `sync/${id}`],
    ] as const) {
      await request(app.getHttpServer())
        [method](`/api/v1/admin/stores/${path}`)
        .expect(401);
      for (const role of ['passenger', 'driver', 'marketer'])
        await request(app.getHttpServer())
          [method](`/api/v1/admin/stores/${path}`)
          .set('x-test-role', role)
          .expect(403);
    }
    Object.values(service).forEach((call) =>
      expect(call).not.toHaveBeenCalled(),
    );
  });
  it.each(['admin', 'super_admin'])(
    'accepts %s and ties changes to JWT actor',
    async (role) => {
      access.permissions.mockImplementation(async (_id, actorRole) =>
        actorRole === 'admin'
          ? STORE_PROFILES.technical
          : storePermissions(actorRole),
      );
      await request(app.getHttpServer())
        .post('/api/v1/admin/stores/google/sync')
        .set('x-test-role', role)
        .send({ task: 'reports', requestId: id })
        .expect(201);
      expect(service.sync).toHaveBeenCalledWith(
        id,
        'google',
        expect.objectContaining({ task: 'reports', requestId: id }),
      );
    },
  );
  it('refuses privilege escalation, fake platforms, invalid IDs and excessive pages', async () => {
    access.permissions.mockImplementation(async () =>
      storePermissions('super_admin'),
    );
    await request(app.getHttpServer())
      .post('/api/v1/admin/stores/google/sync')
      .set('x-test-role', 'admin')
      .send({ task: 'reports', requestId: id, actorId: id })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/admin/stores/attacker/sync')
      .set('x-test-role', 'admin')
      .send({ task: 'reviews', requestId: id })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/admin/stores/records?limit=10000')
      .set('x-test-role', 'admin')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/admin/stores/reviews/not-a-uuid/reply')
      .set('x-test-role', 'admin')
      .send({ text: 'Hello', requestId: id })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/admin/stores/status')
      .set('x-test-role', 'admin')
      .set('x-test-reset', 'true')
      .expect(403);
    Object.values(service).forEach((call) =>
      expect(call).not.toHaveBeenCalled(),
    );
  });
  it('keeps default admins read-only and accepts explicitly granted marketer profiles', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/stores/google/sync')
      .set('x-test-role', 'admin')
      .send({ task: 'reports', requestId: id })
      .expect(403);
    access.permissions.mockImplementation(async () => STORE_PROFILES.support);
    await request(app.getHttpServer())
      .get('/api/v1/admin/store-management/records?kind=review')
      .set('x-test-role', 'marketer')
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/admin/stores/records?kind=release')
      .set('x-test-role', 'marketer')
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/stores/reviews/${id}/approve`)
      .set('x-test-role', 'marketer')
      .send({ revision: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/stores/reviews/${id}/draft`)
      .set('x-test-role', 'marketer')
      .send({ revision: 0, text: 'Merci.' })
      .expect(201);
    expect(operations.draft).toHaveBeenCalledWith(
      id,
      id,
      expect.objectContaining({ revision: 0 }),
    );
  });
  it('rejects arbitrary text at publication and restricts grants to existing super-admin role', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/stores/reviews/${id}/publish`)
      .set('x-test-role', 'super_admin')
      .send({ revision: 1, requestId: id, text: 'Unapproved' })
      .expect(400);
    access.permissions.mockImplementation(async () =>
      storePermissions('super_admin'),
    );
    await request(app.getHttpServer())
      .put(`/api/v1/admin/stores/access/${id}`)
      .set('x-test-role', 'admin')
      .send({ profile: 'validator' })
      .expect(403);
    expect(operations.publish).not.toHaveBeenCalled();
    expect(operations.grant).not.toHaveBeenCalled();
  });
});
