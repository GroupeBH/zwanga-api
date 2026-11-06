import 'reflect-metadata';
import { Injectable, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { RatingsController } from './ratings.controller';
import { RatingsService } from './ratings.service';

// Real HTTP routing, JWT signature verification and DTO pipeline; no application
// bootstrap, credentials, provider requests or application database.
const secret = randomBytes(32).toString('hex');
@Injectable()
class TestRatingJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
      algorithms: ['HS256'],
      ignoreExpiration: false,
    });
  }
  validate(payload: { sub: string }) {
    return { userId: payload.sub };
  }
}

describe('rated trips HTTP contract for the mobile Store review prompt', () => {
  let app: INestApplication<Server>;
  const jwt = new JwtService({ secret });
  const account = randomUUID(),
    trip = randomUUID(),
    secondTrip = randomUUID();
  const ratedTrips = jest.fn((userId: string, tripIds: string[]) =>
    Promise.resolve({
      userId,
      ratedTripIds: tripIds.filter((id) => id === trip),
    }),
  );
  const url = '/api/v1/ratings/mine/trips';
  const token = () => jwt.sign({ sub: account }, { expiresIn: '1m' });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [RatingsController],
      providers: [
        TestRatingJwtStrategy,
        { provide: RatingsService, useValue: { ratedTrips } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
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
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => ratedTrips.mockClear());

  it('returns the mobile response shape and the JWT account for a comma-separated list', async () => {
    const response = await request(app.getHttpServer())
      .get(url)
      .auth(token(), { type: 'bearer' })
      .query({ tripIds: `${trip},${secondTrip}` })
      .expect(200);
    expect(response.body).toEqual({ userId: account, ratedTripIds: [trip] });
    expect(ratedTrips).toHaveBeenCalledWith(account, [trip, secondTrip]);
  });
  it('denies missing, expired and incorrectly signed JWTs before any database lookup', async () => {
    await request(app.getHttpServer())
      .get(url)
      .query({ tripIds: trip })
      .expect(401);
    for (const invalid of [
      jwt.sign({ sub: account }, { expiresIn: -1 }),
      jwt.sign({ sub: account }, { secret: randomBytes(32).toString('hex') }),
    ])
      await request(app.getHttpServer())
        .get(url)
        .auth(invalid, { type: 'bearer' })
        .query({ tripIds: trip })
        .expect(401);
    expect(ratedTrips).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { tripIds: '' },
    { tripIds: 'not-a-uuid' },
    { tripIds: `${trip},${trip}` },
    { tripIds: Array.from({ length: 101 }, () => randomUUID()).join(',') },
    { tripIds: trip, userId: randomUUID() },
  ])('rejects malformed, oversized or forged query %j', async (query) => {
    await request(app.getHttpServer())
      .get(url)
      .auth(token(), { type: 'bearer' })
      .query(query)
      .expect(400);
    expect(ratedTrips).not.toHaveBeenCalled();
  });
});
