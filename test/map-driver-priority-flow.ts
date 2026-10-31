import { DataSource } from 'typeorm';
import { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { User } from '../src/users/entities/user.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { targetMapDriver } from '../src/trip-requests/target-map-driver';
import { requestSearchMap } from '../src/trip-requests/request-search-map';
import { declineRequestForDriver } from '../src/trip-requests/request-refusal';
import { prepareNearbyRequestRinging } from '../src/notifications/nearby-request-cooldown';
import { claimRequestAcceptance } from '../src/trip-requests/dispatch/request-acceptance';
import { SequentialDispatchService } from '../src/trip-requests/dispatch/sequential-dispatch.service';
import { RequestDriverQueue } from '../src/trip-requests/dispatch/request-driver-queue';
import { TripRequestsController } from '../src/trip-requests/trip-requests.controller';
import { TripRequestsService } from '../src/trip-requests/trip-requests.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { Test } from '@nestjs/testing';
import { ExecutionContext, ValidationPipe } from '@nestjs/common';
import supertest from 'supertest';
import type { Server } from 'node:http';

type Fixture = {
  db: DataSource;
  relay: SequentialDispatchService;
  queue: RequestDriverQueue;
  driver: (longitude?: number) => Promise<User>;
  request: () => Promise<TripRequest>;
  offers: (
    id: string,
  ) => Promise<
    { id: string; driverId: string; status: string; expiresAt: Date }[]
  >;
};
export function mapDriverPriorityFlow(get: () => Fixture) {
  const select = async (r: TripRequest, index = 0) => {
    const { db } = get();
    const map = await requestSearchMap(db.manager, r.passengerId, r.id);
    const dto = {
      markerId: map.vehicles[index].id,
      expectedUpdatedAt: r.updatedAt.toISOString(),
    };
    await targetMapDriver(db.manager, r.passengerId, r.id, dto);
    return dto;
  };
  it('map selection grants 180 seconds, pauses all other invitations and does not extend on HTTP retry', async () => {
    const { db, driver, request, relay, offers } = get();
    const first = await driver(),
      second = await driver(15.311),
      r = await request();
    await relay.advance(r.id);
    expect((await offers(r.id))[0].driverId).toBe(first.id);
    const dto = await select(r, 1);
    const chosen = await db
      .getRepository(TripRequest)
      .findOneByOrFail({ id: r.id });
    expect(chosen.targetDriverId).toBe(second.id);
    expect(
      chosen.targetDriverPriorityUntil!.getTime() - Date.now(),
    ).toBeGreaterThan(175000);
    expect(
      chosen.targetDriverPriorityUntil!.getTime() - Date.now(),
    ).toBeLessThanOrEqual(180000);
    await targetMapDriver(db.manager, r.passengerId, r.id, dto);
    await relay.advance(r.id);
    expect((await offers(r.id)).filter((o) => o.status === 'pending')).toEqual([
      expect.objectContaining({ driverId: second.id }),
    ]);
    const again = await db
      .getRepository(TripRequest)
      .findOneByOrFail({ id: r.id });
    expect(again.targetDriverPriorityUntil).toEqual(
      chosen.targetDriverPriorityUntil,
    );
    await expect(
      claimRequestAcceptance(db.manager, again, first.id),
    ).rejects.toThrow();
  });
  it('target refusal immediately resumes the ordinary 40-second queue', async () => {
    const { db, driver, request, relay, offers } = get();
    const first = await driver(),
      second = await driver(15.311),
      r = await request();
    await select(r);
    await declineRequestForDriver(db.manager, first.id, r.id);
    expect(await relay.advance(r.id)).toBe(true);
    const pending = (await offers(r.id)).find((o) => o.status === 'pending');
    expect(pending.driverId).toBe(second.id);
    expect(
      new Date(pending.expiresAt).getTime() - Date.now(),
    ).toBeLessThanOrEqual(40000);
    expect(
      (await db.getRepository(TripRequest).findOneByOrFail({ id: r.id }))
        .targetDriverId,
    ).toBeNull();
    expect(
      (await requestSearchMap(db.manager, r.passengerId, r.id)).vehicles,
    ).toHaveLength(1);
  });
  it('SQL recovers an elapsed three-minute priority after loss of Redis deadlines and a worker restart', async () => {
    const { db, driver, request, relay, queue, offers } = get();
    await driver();
    const second = await driver(15.311),
      r = await request();
    await select(r);
    // Advance only the durable deadlines, not a client timer or a fake JS clock.
    await db.query(
      'UPDATE trip_requests SET "targetDriverPriorityUntil"=now()-interval \'1 second\' WHERE id=$1',
      [r.id],
    );
    await db.query(
      'UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval \'1 second\' WHERE "requestId"=$1',
      [r.id],
    );
    await queue.close(r.id);
    jest
      .spyOn(queue, 'due')
      .mockRejectedValue(new Error('deadline read unavailable'));
    await relay.deadlines();
    expect((await offers(r.id)).filter((o) => o.status === 'pending')).toEqual([
      expect.objectContaining({ driverId: second.id }),
    ]);
    expect(
      (await db.getRepository(TripRequest).findOneByOrFail({ id: r.id }))
        .targetDriverPriorityUntil,
    ).toBeNull();
  });
  it('retargeting a previously alerted driver replaces old action IDs and prepares exactly the new ring', async () => {
    const { db, driver, request, relay, offers } = get();
    await driver();
    const r = await request();
    await relay.advance(r.id);
    const oldId = (await offers(r.id))[0].id;
    const old = await db
      .getRepository(Notification)
      .findOneByOrFail({ eventKey: `sequential-offer:${oldId}` });
    expect(await prepareNearbyRequestRinging(db.manager, old)).toBe(true);
    await select(r);
    const pending = (await offers(r.id)).find((o) => o.status === 'pending');
    expect(pending.id).not.toBe(oldId);
    const fresh = (
      await db
        .getRepository(Notification)
        .find({ where: { userId: old.userId } })
    ).find((n) => n.data?.mapDriverPriority === true)!;
    expect(await prepareNearbyRequestRinging(db.manager, fresh)).toBe(true);
    expect(await prepareNearbyRequestRinging(db.manager, old)).toBe(false);
    expect(
      (await db.getRepository(Notification).findOneByOrFail({ id: old.id }))
        .isActive,
    ).toBe(false);
  });
  it('selection and driver acceptance cannot create two owners under a concurrent race', async () => {
    const { db, driver, request, relay, offers } = get();
    const first = await driver();
    await driver(15.311);
    const r = await request();
    await relay.advance(r.id);
    const map = await requestSearchMap(db.manager, r.passengerId, r.id);
    const result = await Promise.allSettled([
      targetMapDriver(db.manager, r.passengerId, r.id, {
        markerId: map.vehicles[1].id,
        expectedUpdatedAt: r.updatedAt.toISOString(),
      }),
      claimRequestAcceptance(db.manager, r, first.id),
    ]);
    expect(result.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await offers(r.id)).filter((o) => o.status === 'pending'),
    ).toHaveLength(1);
  });
  it('HTTP controller validates opaque markers and owner identity before the real SQL mutation', async () => {
    const { db, driver, request } = get();
    await driver();
    const r = await request();
    const map = await requestSearchMap(db.manager, r.passengerId, r.id);
    expect(map.vehicles[0]).not.toHaveProperty('driverId');
    const dto = {
      markerId: map.vehicles[0].id,
      expectedUpdatedAt: r.updatedAt.toISOString(),
    };
    let actor = '00000000-0000-4000-8000-000000000001';
    const module = await Test.createTestingModule({
      controllers: [TripRequestsController],
      providers: [
        {
          provide: TripRequestsService,
          useValue: {
            targetDriverFromMap: async (
              owner: string,
              id: string,
              body: typeof dto,
            ) => {
              await targetMapDriver(db.manager, owner, id, body);
              return db.getRepository(TripRequest).findOneByOrFail({ id });
            },
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context
            .switchToHttp()
            .getRequest<{ user: { userId: string } }>().user = {
            userId: actor,
          };
          return true;
        },
      })
      .compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    try {
      const call = () =>
        supertest(app.getHttpServer() as Server).post(
          `/trip-requests/${r.id}/target-map-driver`,
        );
      await call().send(dto).expect(404);
      actor = r.passengerId;
      await call()
        .send({ ...dto, driverId: actor })
        .expect(400);
      await call()
        .send({ ...dto, markerId: actor })
        .expect(400);
      await call()
        .send({ ...dto, expectedUpdatedAt: new Date(0).toISOString() })
        .expect(409);
      await call().send(dto).expect(201);
      await call().send(dto).expect(201);
    } finally {
      await app.close();
    }
  });
}
