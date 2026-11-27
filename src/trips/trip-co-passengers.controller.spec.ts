import { Test } from '@nestjs/testing';
import {
  UnauthorizedException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TripCoPassengersController } from './trip-co-passengers.controller';
import { TripCoPassengersService } from './trip-co-passengers.service';

describe('Co-passengers HTTP boundary (isolated test guard)', () => {
  let app: INestApplication<Server>;
  const tripId = '00000000-0000-4000-8000-000000000001';
  const list = jest.fn().mockResolvedValue({ tripId, participants: [] });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TripCoPassengersController],
      providers: [{ provide: TripCoPassengersService, useValue: { list } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<{
            headers: { authorization?: string };
            user?: { userId: string };
          }>();
          if (req.headers.authorization !== 'Bearer local-test')
            throw new UnauthorizedException();
          req.user = { userId: 'authenticated-viewer' };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<INestApplication<Server>>();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => list.mockClear());
  it('rejects unauthenticated calls without reading the roster', async () => {
    await request(app.getHttpServer())
      .get(`/trips/${tripId}/co-passengers`)
      .expect(401);
    expect(list).not.toHaveBeenCalled();
  });
  it('validates the trip identifier', async () => {
    await request(app.getHttpServer())
      .get('/trips/not-a-uuid/co-passengers')
      .set('Authorization', 'Bearer local-test')
      .expect(400);
    expect(list).not.toHaveBeenCalled();
  });
  it('uses the authenticated identity, not a supplied viewer, and disallows HTTP caching', async () => {
    const result = await request(app.getHttpServer())
      .get(`/trips/${tripId}/co-passengers?viewerId=someone-else`)
      .set('Authorization', 'Bearer local-test')
      .expect(200);
    expect(list).toHaveBeenCalledWith(tripId, 'authenticated-viewer');
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({ tripId, participants: [] });
  });
});
