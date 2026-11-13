import { INestApplication, ValidationPipe } from '@nestjs/common';
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
    proposeCounterOffer: jest.fn().mockResolvedValue({ status: 'pending' }),
    mapDriver: jest.fn().mockResolvedValue({ driverId: 'resolved-driver' }),
    rejectOffer: jest.fn().mockResolvedValue({ status: 'pending' }),
    negotiatePrice: jest.fn().mockResolvedValue({ status: 'offers_received' }),
    acceptPassengerPrice: jest.fn().mockResolvedValue({ status: 'driver_selected' }),
    priceAlternatives: jest.fn().mockResolvedValue({ recent: 0, older: 0 }),
    getPassengerContact: jest.fn().mockResolvedValue({ passenger: { id: 'passenger', phone: null } }),
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
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app?.close();
    passport.unuse('jwt');
  });

  beforeEach(() => jest.clearAllMocks());

  it('authenticates bounded bargaining routes, forbids forged actors, validates money and restricts driver decisions', async () => {
    const id = '11111111-1111-4111-8111-111111111111', offerId = '22222222-2222-4222-8222-222222222222';
    const path = `/trip-requests/${id}/offers/${offerId}`;
    const passenger = `Bearer ${jwt.sign({ userId: 'passenger', role: UserRole.PASSENGER })}`;
    const driver = `Bearer ${jwt.sign({ userId: 'driver', role: UserRole.DRIVER })}`;
    for (const action of ['passenger-price', 'final-price', 'accept-passenger-price'])
      await request(server).post(`${path}/${action}`).send({ pricePerSeat: 2700 }).expect(401);
    for (const action of ['final-price', 'accept-passenger-price'])
      await request(server).post(`${path}/${action}`).set('Authorization', passenger).send({ pricePerSeat: 2700 }).expect(403);
    for (const pricePerSeat of [0, -1, 1.5, 1000001, '2700', null])
      await request(server).post(`${path}/passenger-price`).set('Authorization', passenger).send({ pricePerSeat }).expect(400);
    await request(server).post(`${path}/passenger-price`).set('Authorization', passenger).send({ pricePerSeat: 2700, passengerId: 'someone-else' }).expect(400);
    expect(service.negotiatePrice).not.toHaveBeenCalled();
    await request(server).post(`${path}/passenger-price`).set('Authorization', passenger).send({ pricePerSeat: 2700 }).expect(201);
    expect(service.negotiatePrice).toHaveBeenLastCalledWith('passenger', id, offerId, 2700, 'passenger_counter');
    await request(server).post(`${path}/final-price`).set('Authorization', driver).send({ pricePerSeat: 2800 }).expect(201);
    expect(service.negotiatePrice).toHaveBeenLastCalledWith('driver', id, offerId, 2800, 'driver_final');
    await request(server).post(`${path}/accept-passenger-price`).set('Authorization', driver).send({}).expect(201);
    expect(service.acceptPassengerPrice).toHaveBeenCalledWith('driver', id, offerId);
    await request(server).get(`${path}/alternatives`).expect(401);
    await request(server).get(`${path}/alternatives`).set('Authorization', passenger).expect(200).expect('Cache-Control', 'private, no-store');
    expect(service.priceAlternatives).toHaveBeenCalledWith('passenger', id, offerId);
  });

  it('protects counteroffers with JWT, role, price and vehicle validation; ignores no forged identity', async () => {
    const id = '11111111-1111-4111-8111-111111111111', vehicleId = '22222222-2222-4222-8222-222222222222';
    const path = `/trip-requests/${id}/counter-offer`, dto = { vehicleId, pricePerSeat: 1500 };
    const auth = `Bearer ${jwt.sign({ userId: 'driver', role: UserRole.DRIVER })}`;
    await request(server).post(path).send(dto).expect(401);
    await request(server).post(path).set('Authorization', `Bearer ${jwt.sign({ userId: 'passenger', role: UserRole.PASSENGER })}`).send(dto).expect(403);
    for (const pricePerSeat of [-1, 0, 1.5, 1000001, '1500', null])
      await request(server).post(path).set('Authorization', auth).send({ ...dto, pricePerSeat }).expect(400);
    await request(server).post(path).set('Authorization', auth).send({ ...dto, vehicleId: 'bad' }).expect(400);
    await request(server).post(path).set('Authorization', auth).send({ ...dto, driverId: 'other' }).expect(400);
    expect(service.proposeCounterOffer).not.toHaveBeenCalled();
    await request(server).post(path).set('Authorization', auth).send(dto).expect(201);
    expect(service.proposeCounterOffer).toHaveBeenCalledWith('driver', id, dto);
  });

  it('map lookup requires authenticated ownership downstream and an opaque marker, not a driver UUID', async () => {
    const id = '11111111-1111-4111-8111-111111111111', path = `/trip-requests/${id}/map-driver`;
    const auth = `Bearer ${jwt.sign({ userId: 'passenger', role: UserRole.PASSENGER })}`;
    await request(server).get(path).expect(401);
    for (const markerId of ['', id, 'g'.repeat(64)])
      await request(server).get(path).query({ markerId }).set('Authorization', auth).expect(400);
    expect(service.mapDriver).not.toHaveBeenCalled();
    await request(server).get(path).query({ markerId: 'a'.repeat(64) }).set('Authorization', auth)
      .expect('Cache-Control', 'private, no-store').expect(200);
    expect(service.mapDriver).toHaveBeenCalledWith('passenger', id, 'a'.repeat(64));
  });

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

  it('protects explicit passenger contact with authentication, role and UUID validation', async () => {
    const path = '/trip-requests/11111111-1111-4111-8111-111111111111/passenger-contact';
    await request(server).get(path).expect(401);
    for (const role of [UserRole.PASSENGER, UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      await request(server).get(path).set('Authorization', `Bearer ${jwt.sign({ userId: 'stranger', role })}`).expect(403);
    }
    const token = jwt.sign({ userId: 'driver', role: UserRole.DRIVER });
    await request(server).get('/trip-requests/not-an-id/passenger-contact').set('Authorization', `Bearer ${token}`).expect(400);
    expect(service.getPassengerContact).not.toHaveBeenCalled();
    await request(server).get(path + '?driverId=someone-else').set('Authorization', `Bearer ${token}`)
      .expect('Cache-Control', 'private, no-store').expect(200);
    expect(service.getPassengerContact).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'driver');
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', TripRequestsController.prototype.getPassengerContact)).toBe(10);
  });

  it('Home scope retains real authentication/role guards and ignores a supplied driver identity', async () => {
    const path = '/trip-requests?scope=home&driverId=someone-else';
    await request(server).get(path).expect(401);
    await request(server).get(path).set('Authorization', `Bearer ${jwt.sign({ userId: 'passenger', role: UserRole.PASSENGER })}`).expect(403);
    expect(service.findAll).not.toHaveBeenCalled();
    await request(server).get(path).set('Authorization', `Bearer ${jwt.sign({ userId: 'driver', role: UserRole.DRIVER })}`)
      .expect('Cache-Control', 'private, no-store').expect(200, []);
    expect(service.findAll).toHaveBeenCalledWith('driver', true);
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
