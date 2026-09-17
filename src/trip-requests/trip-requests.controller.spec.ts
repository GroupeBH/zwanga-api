import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import passport from 'passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import type { Server } from 'node:http';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { TripRequestsController } from './trip-requests.controller';
import { TripRequestsService } from './trip-requests.service';

describe('Trip requests HTTP access', () => {
  let app: INestApplication;
  let server: Server;
  const jwt = new JwtService({ secret: 'trip-request-http-tests-only' });
  const service = {
    findAll: jest.fn().mockResolvedValue([]),
    findByDriver: jest.fn().mockResolvedValue([]),
    createDriverOffer: jest.fn(),
    acceptTripRequest: jest.fn(),
    startTripFromRequest: jest.fn(),
  };

  beforeAll(async () => {
    // Real signature validation and the application's JWT/role guards, no external DB.
    passport.use(
      'jwt',
      new Strategy(
        {
          jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
          secretOrKey: 'trip-request-http-tests-only',
        },
        (payload: { userId: string; role: UserRole }, done) =>
          done(null, payload),
      ),
    );
    const module = await Test.createTestingModule({
      controllers: [TripRequestsController],
      providers: [
        { provide: TripRequestsService, useValue: service },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(passport.initialize());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app?.close();
    passport.unuse('jwt');
  });

  beforeEach(() => jest.clearAllMocks());

  it('returns 401 for anonymous listing', async () => {
    await request(server).get('/trip-requests').expect(401);
    expect(service.findAll).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid bearer token', async () => {
    await request(server)
      .get('/trip-requests')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
    expect(service.findAll).not.toHaveBeenCalled();
  });

  it.each([UserRole.PASSENGER, UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    'returns 403 for the non-driver role %s',
    async (role) => {
      const token = jwt.sign({ userId: 'other-user', role });
      await request(server)
        .get('/trip-requests')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect(service.findAll).not.toHaveBeenCalled();
    },
  );

  it('uses the authenticated driver identity and prevents response caching', async () => {
    const token = jwt.sign({ userId: 'driver', role: UserRole.DRIVER });
    await request(server)
      .get('/trip-requests?driverId=other-driver')
      .set('Authorization', `Bearer ${token}`)
      .expect('Cache-Control', 'private, no-store')
      .expect(200, []);
    expect(service.findAll).toHaveBeenCalledWith('driver');
  });

  it('denies passengers access to my-offers', async () => {
    const token = jwt.sign({ userId: 'passenger', role: UserRole.PASSENGER });
    await request(server)
      .get('/trip-requests/my-offers')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(service.findByDriver).not.toHaveBeenCalled();
  });

  it('denies passengers offer creation, direct acceptance and driver start to prevent contact access bypass', async () => {
    const token = jwt.sign({ userId: 'passenger', role: UserRole.PASSENGER });
    for (const action of ['offers', 'accept']) {
      await request(server)
        .post(`/trip-requests/request/${action}`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);
    }
    await request(server)
      .put('/trip-requests/request/start-trip')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(service.createDriverOffer).not.toHaveBeenCalled();
    expect(service.acceptTripRequest).not.toHaveBeenCalled();
    expect(service.startTripFromRequest).not.toHaveBeenCalled();
  });
});
