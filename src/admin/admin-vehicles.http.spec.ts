import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminVehiclesController } from './admin-vehicles.controller';
import { AdminVehiclesService } from './admin-vehicles.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';

describe('admin vehicle HTTP contract (loopback, synthetic authentication)', () => {
  let app: INestApplication;
  const id = '10000000-0000-4000-8000-000000000001';
  const service = {
    list: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    deactivate: jest.fn(),
  };
  beforeAll(async () => {
    // Replace only authentication: exercise real role checks, routing, UUID
    // and DTO pipes without accounts, application configuration or AWS.
    const module = await Test.createTestingModule({
      controllers: [AdminVehiclesController],
      providers: [{ provide: AdminVehiclesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(
      {
        canActivate(context) {
          const req = context.switchToHttp().getRequest();
          const role = req.headers['x-test-role'];
          if (!role) throw new UnauthorizedException();
          req.user = { userId: 'authenticated-actor', role };
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
    service.list.mockResolvedValue({
      vehicles: [],
      total: 0,
      page: 1,
      limit: 25,
    });
    service.get.mockResolvedValue({ id });
    service.update.mockResolvedValue({ id, isActive: false });
    service.deactivate.mockResolvedValue({ id, isActive: false });
  });

  it('requires authentication and denies driver/passenger/marketer access to every route', async () => {
    for (const [method, path] of [
      ['get', ''],
      ['get', `/${id}`],
      ['put', `/${id}`],
      ['put', `/${id}/deactivate`],
    ] as const) {
      await request(app.getHttpServer())
        [method](`/api/v1/admin/vehicles${path}`)
        .expect(401);
      for (const role of [
        UserRole.DRIVER,
        UserRole.PASSENGER,
        UserRole.MARKETER,
      ]) {
        await request(app.getHttpServer())
          [method](`/api/v1/admin/vehicles${path}`)
          .set('x-test-role', role)
          .expect(403);
      }
    }
    for (const call of Object.values(service))
      expect(call).not.toHaveBeenCalled();
  });

  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    'accepts %s and binds filters to the authenticated actor',
    async (role) => {
      await request(app.getHttpServer())
        .get(
          '/api/v1/admin/vehicles?vehicleType=car&isActive=false&page=2&limit=20',
        )
        .set('x-test-role', role)
        .expect(200);
      expect(service.list).toHaveBeenCalledWith(
        'authenticated-actor',
        expect.objectContaining({
          vehicleType: 'car',
          isActive: 'false',
          page: 2,
          limit: 20,
        }),
      );
      await request(app.getHttpServer())
        .get(`/api/v1/admin/vehicles/${id}`)
        .set('x-test-role', role)
        .expect(200);
      expect(service.get).toHaveBeenCalledWith('authenticated-actor', id);
      await request(app.getHttpServer())
        .put(`/api/v1/admin/vehicles/${id}`)
        .set('x-test-role', role)
        .send({ color: ' Blue ', isActive: false })
        .expect(200);
      expect(service.update).toHaveBeenCalledWith(
        'authenticated-actor',
        id,
        expect.objectContaining({ color: 'Blue', isActive: false }),
      );
      await request(app.getHttpServer())
        .put(`/api/v1/admin/vehicles/${id}/deactivate`)
        .set('x-test-role', role)
        .expect(200);
      expect(service.deactivate).toHaveBeenCalledWith(
        'authenticated-actor',
        id,
      );
    },
  );

  it('rejects unknown types, invalid pagination, malformed UUIDs and ownership changes at the HTTP boundary', async () => {
    for (const query of [
      'vehicleType=truck',
      'page=1.5',
      'limit=201',
      'isActive=maybe',
    ]) {
      await request(app.getHttpServer())
        .get(`/api/v1/admin/vehicles?${query}`)
        .set('x-test-role', UserRole.ADMIN)
        .expect(400);
    }
    await request(app.getHttpServer())
      .put('/api/v1/admin/vehicles/not-a-uuid/deactivate')
      .set('x-test-role', UserRole.ADMIN)
      .expect(400);
    for (const patch of [
      { ownerId: 'other' },
      { id: 'other' },
      { isActive: 'false' },
      { model: null },
      { brand: '   ' },
    ]) {
      await request(app.getHttpServer())
        .put(`/api/v1/admin/vehicles/${id}`)
        .set('x-test-role', UserRole.ADMIN)
        .send(patch)
        .expect(400);
    }
    for (const call of Object.values(service))
      expect(call).not.toHaveBeenCalled();
  });
});
