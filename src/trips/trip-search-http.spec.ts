import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { BookingsService } from '../bookings/bookings.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

describe('Trip search coordinate compatibility over HTTP', () => {
  let app: INestApplication;
  let server: Server;
  const service = {
    search: jest.fn().mockResolvedValue([]),
    findAll: jest.fn().mockResolvedValue([]),
    searchPage: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TripsController],
      providers: [
        { provide: TripsService, useValue: service },
        { provide: BookingsService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // Match main.ts transformation and validation, without external services.
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }));
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => { await app?.close(); });
  beforeEach(() => jest.clearAllMocks());

  it('accepts the exact GET query from the reported mobile error', async () => {
    await request(server)
      .get('/api/v1/trips?minSeats=1&limit=50&departureCoordinates=15.31251%2C-4.33215&departureRadiusKm=25&sort=date')
      .expect(200, []);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({
      minSeats: 1, limit: 50, departureCoordinates: [15.31251, -4.33215],
      departureRadiusKm: 25, sort: 'date',
    }));
  });

  it.each(['departureCoordinates', 'arrivalCoordinates'])(
    'accepts a standalone CSV %s without requiring the other point', async field => {
      await request(server).get('/api/v1/trips').query({ [field]: ' 15.31251 , -4.33215 ' }).expect(200, []);
      expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ [field]: [15.31251, -4.33215] }));
    },
  );

  it('accepts both points without reversing longitude and latitude', async () => {
    await request(server).get('/api/v1/trips').query({
      departureCoordinates: '15.31251,-4.33215', arrivalCoordinates: '15.3222,-4.4419',
    }).expect(200, []);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({
      departureCoordinates: [15.31251, -4.33215], arrivalCoordinates: [15.3222, -4.4419],
    }));
  });

  it('accepts coordinates serialized as repeated query parameters', async () => {
    await request(server).get('/api/v1/trips?departureCoordinates=15.31251&departureCoordinates=-4.33215').expect(200, []);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ departureCoordinates: [15.31251, -4.33215] }));
  });

  it('does not confuse an explicit zero with an empty coordinate', async () => {
    await request(server).get('/api/v1/trips?departureCoordinates=0%2C0').expect(200, []);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ departureCoordinates: [0, 0] }));
  });

  it('keeps the unfiltered list and text search available without coordinates', async () => {
    await request(server).get('/api/v1/trips').expect(200, []);
    await request(server).get('/api/v1/trips?keywords=gombe').expect(200, []);
    expect(service.search).toHaveBeenLastCalledWith(expect.objectContaining({ keywords: 'gombe' }));
    for (const [query] of service.search.mock.calls) {
      expect(query.departureCoordinates).toBeUndefined();
      expect(query.arrivalCoordinates).toBeUndefined();
    }
  });

  describe.each(['departureCoordinates', 'arrivalCoordinates'])('%s validation', field => {
    it.each([
      '', ',', '15.3,', ', -4.3', '15.3,   ', '15.3', '15.3,-4.3,1',
      'abc,-4.3', '15.3garbage,-4.3', 'NaN,-4.3', 'Infinity,-4.3',
      '1e999,-4.3', '181,-4.3', '-181,-4.3', '15.3,181',
      '0x0f,-4.3', 'true,-4.3', '[15.3,-4.3]',
    ])('still rejects malformed CSV %j before calling the service', async value => {
      await request(server).get('/api/v1/trips').query({ [field]: value }).expect(400);
      expect(service.search).not.toHaveBeenCalled();
      expect(service.findAll).not.toHaveBeenCalled();
    });

    it.each([
      [true, -4.3], [null, -4.3], [[15.3], -4.3], [{ value: 15.3 }, -4.3],
      ['', -4.3], [15.3], [15.3, -4.3, 1], { longitude: 15.3, latitude: -4.3 },
    ].map(value => ({ value })))('still rejects malformed JSON %j', async ({ value }) => {
      await request(server).post('/api/v1/trips/discovery').send({ [field]: value }).expect(400);
      expect(service.searchPage).not.toHaveBeenCalled();
    });
  });

  it('preserves JSON numeric coordinates on both existing POST searches', async () => {
    const body = {
      departureCoordinates: [15.31251, -4.33215], arrivalCoordinates: [15.3222, -4.4419],
      minSeats: 1, limit: 50, departureRadiusKm: 25, sort: 'date',
    };
    await request(server).post('/api/v1/trips/search/coordinates').send(body).expect(201, []);
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining(body));
    await request(server).post('/api/v1/trips/discovery').send(body).expect(201, { data: [], nextCursor: null });
    expect(service.searchPage).toHaveBeenCalledWith(expect.objectContaining(body));
  });

  it('continues rejecting unknown filters', async () => {
    await request(server).get('/api/v1/trips?unexpected=true').expect(400);
    expect(service.search).not.toHaveBeenCalled();
    expect(service.findAll).not.toHaveBeenCalled();
  });
});
