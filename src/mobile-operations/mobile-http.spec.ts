import {
  Global,
  INestApplication,
  Module,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { MobileAdminController } from './mobile-admin.controller';
import { MobileController } from './mobile.controller';
import { MobileInstallationsService } from './mobile-installations.service';
import { MobilePoliciesService } from './mobile-policies.service';
import { MobileCampaignsService } from './mobile-campaigns.service';
import { MobileAnalyticsService } from './mobile-analytics.service';
import { MobileMaintenanceService } from './mobile-maintenance.service';
import {
  StoreAccess,
  StorePermissionsGuard,
  storePermissions,
} from '../store-management/store.permissions';
import { StoreService } from '../store-management/store.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { MobileOperationsModule } from './mobile-operations.module';
import { CacheService } from '../common/services/cache.service';

describe('Mobile Operations HTTP authorization and strict DTOs', () => {
  let app: INestApplication;
  const id = '10000000-0000-4000-8000-000000000001';
  const installations = {
    register: jest.fn(async () => ({ registered: true })),
    link: jest.fn(async () => ({ linked: true })),
    list: jest.fn(async () => ({ items: [] })),
  };
  const policies = {
    check: jest.fn(async () => ({ required: false })),
    save: jest.fn(async () => ({})),
  };
  const campaigns = {
    action: jest.fn(async () => ({})),
    save: jest.fn(async () => ({})),
  };
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [MobileController, MobileAdminController],
      providers: [
        StorePermissionsGuard,
        {
          provide: StoreAccess,
          useValue: {
            permissions: async (_id: string, role: string) =>
              storePermissions(role),
          },
        },
        { provide: MobileInstallationsService, useValue: installations },
        { provide: MobilePoliciesService, useValue: policies },
        { provide: MobileCampaignsService, useValue: campaigns },
        { provide: MobileAnalyticsService, useValue: {} },
        { provide: MobileMaintenanceService, useValue: {} },
        { provide: StoreService, useValue: {} },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/v1');
    const reflector = new Reflector();
    app.useGlobalGuards(
      {
        canActivate(ctx) {
          const req = ctx.switchToHttp().getRequest();
          const role = req.headers['x-test-role'];
          if (role) req.user = { userId: id, role };
          if (
            !role &&
            !reflector.getAllAndOverride('isPublic', [
              ctx.getHandler(),
              ctx.getClass(),
            ])
          )
            throw new UnauthorizedException();
          return true;
        },
      },
      new RolesGuard(reflector),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());
  it('allows public version checks but requires authentication for association', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/mobile/version/check')
      .send({
        platform: 'android',
        environment: 'production',
        version: '1',
        build: '145',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/mobile/installations/${id}/link`)
      .send({ sequence: 1 })
      .expect(401);
  });
  it('blocks unauthenticated and ordinary-user inventory access; read-only admin cannot launch', async () => {
    const url = '/api/v1/admin/mobile-operations';
    await request(app.getHttpServer()).get(`${url}/installations`).expect(401);
    await request(app.getHttpServer())
      .get(`${url}/installations`)
      .set('x-test-role', 'driver')
      .expect(403);
    await request(app.getHttpServer())
      .get(`${url}/installations`)
      .set('x-test-role', 'admin')
      .expect(200);
    await request(app.getHttpServer())
      .post(`${url}/campaigns/${id}/launch`)
      .set('x-test-role', 'admin')
      .send({ revision: 1, confirmed: true })
      .expect(403);
    await request(app.getHttpServer())
      .post(`${url}/campaigns/${id}/launch`)
      .set('x-test-role', 'super_admin')
      .send({ revision: 1, confirmed: true })
      .expect(201);
  });
  it('never accepts a userId or role supplied in anonymous registration', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/mobile/installations/${id}`)
      .set('x-installation-secret', 'a'.repeat(64))
      .send({
        platform: 'android',
        version: '1',
        build: '145',
        sequence: 1,
        enabled: false,
        environment: 'production',
        pushProvider: 'fcm',
        notificationPermission: 'denied',
        preferences: { operational: false, updates: false, marketing: false },
        userId: id,
        role: 'driver',
      })
      .expect(400);
    expect(installations.register).not.toHaveBeenCalled();
  });
  it('passes the authenticated actor, not client input, into the association', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/mobile/installations/${id}/link`)
      .set('x-test-role', 'passenger')
      .set('x-installation-secret', 'a'.repeat(64))
      .send({ sequence: 2 })
      .expect(201);
    expect(installations.link).toHaveBeenCalledWith(id, 'a'.repeat(64), id, 2);
  });
});
describe('Mobile module disabled by default', () => {
  it('resolves all real providers and no cron touches schema or external services', async () => {
    const db = {
      options: { type: 'postgres' },
      entityMetadatas: [],
      getRepository: jest.fn(() => ({})),
      query: jest.fn(),
      transaction: jest.fn(),
    };
    @Global()
    @Module({
      providers: [
        { provide: DataSource, useValue: db },
        { provide: ConfigService, useValue: new ConfigService({}) },
        { provide: CacheService, useValue: {} },
      ],
      exports: [DataSource, ConfigService, CacheService],
    })
    class ExistingServices {}
    const mod = await Test.createTestingModule({
      imports: [ExistingServices, MobileOperationsModule],
    }).compile();
    const app = mod.createNestApplication();
    try {
      await app.init();
      db.getRepository.mockClear();
      await app.get(MobileCampaignsService).enqueue();
      await app.get(MobileMaintenanceService).monitor();
      await app.get(MobileMaintenanceService).retain();
      expect(
        await app
          .get(MobilePoliciesService)
          .check({
            platform: 'android',
            environment: 'production',
            version: '1',
            build: '145',
          }),
      ).toMatchObject({ mode: 'NONE' });
      expect(db.query).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
