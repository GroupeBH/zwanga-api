import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  TripRequest,
  TripRequestStatus,
} from '../src/trip-requests/entities/trip-request.entity';
import { User } from '../src/users/entities/user.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { NotificationService } from '../src/notifications/notifications.service';
import { RideAlertChanges } from '../src/notifications/ride-alert-changes';
import { SequentialDispatchService } from '../src/trip-requests/dispatch/sequential-dispatch.service';
import { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import { RequestDriverQueue } from '../src/trip-requests/dispatch/request-driver-queue';
import {
  claimRequestAcceptance,
  startPassengerDecision,
} from '../src/trip-requests/dispatch/request-acceptance';
import { assertSequentialInvitation } from '../src/trip-requests/dispatch/sequential-policy';
import { FourDriverDispatchWaves1780000123000 } from '../src/database/migrations/1780000123000-FourDriverDispatchWaves';
import { startReceivedResponseWindow } from '../src/trip-requests/dispatch/receipt-response-window';

type Offer = {
  id: string;
  driverId: string;
  vehicleId: string;
  status: string;
  waveSlot: number;
  expiresAt: Date;
  phase: string;
};
type Context = {
  db: DataSource;
  config: ConfigService;
  relay: SequentialDispatchService;
  dispatch: DriverDispatchService;
  queue: RequestDriverQueue;
  notifications: Pick<
    NotificationService,
    'dispatchUrgentNotifications' | 'dispatchTransactionalNotifications'
  >;
  changes: Pick<RideAlertChanges, 'enqueue'>;
  driver: (longitude?: number) => Promise<User>;
  request: (
    immediate?: boolean,
    target?: string | null,
  ) => Promise<TripRequest>;
  offers: (id: string) => Promise<Offer[]>;
  notices: (id: string) => Promise<Notification[]>;
};

export function fourDriverWaveFlow(context: () => Context) {
  describe('four-driver waves', () => {
    beforeEach(() => context().config.set('DRIVER_DISPATCH_WAVE_SIZE', '4'));
    const prepare = async (count = 8, immediate = true) => {
      const c = context(),
        drivers: User[] = [];
      for (let i = 0; i < count; i++)
        drivers.push(await c.driver(15.31 + i * 0.0001));
      const request = await c.request(immediate);
      await c.relay.advance(request.id);
      return { ...c, drivers, request };
    };
    const isDeliverable = (notification: Notification) => {
      const c = context();
      const notifier = Object.create(
        NotificationService.prototype,
      ) as NotificationService;
      Object.assign(notifier, {
        notificationRepository: c.db.getRepository(Notification),
        configService: c.config,
      });
      return notifier['isCriticalNotificationStillDeliverable'](notification);
    };

    it('commits four closest invitations and four outbox entries without refilling a partial wave', async () => {
      const c = await prepare();
      const first = await c.offers(c.request.id);
      expect(first).toHaveLength(4);
      expect(new Set(first.map((o) => o.driverId))).toEqual(
        new Set(c.drivers.slice(0, 4).map((d) => d.id)),
      );
      expect(first.map((o) => o.waveSlot).sort()).toEqual([1, 2, 3, 4]);
      expect(
        (await c.notices(c.request.id)).filter((n) => n.isActive),
      ).toHaveLength(4);
      for (const n of await c.notices(c.request.id))
        expect(await isDeliverable(n)).toBe(true);
      for (const o of first)
        expect((await c.dispatch.getOffer(o.driverId, o.id)).actionable).toBe(
          true,
        );
      expect(
        first.every((o) => o.expiresAt.getTime() <= Date.now() + 40_000),
      ).toBe(true);
      await c.dispatch.respond(first[0].driverId, first[0].id, 'decline');
      await c.relay.advance(c.request.id);
      expect(await c.offers(c.request.id)).toHaveLength(4);
      for (const offer of first.slice(1))
        await c.dispatch.respond(offer.driverId, offer.id, 'decline');
      const all = await c.offers(c.request.id);
      expect(all).toHaveLength(8);
      expect(
        new Set(
          all.filter((o) => o.status === 'pending').map((o) => o.driverId),
        ),
      ).toEqual(new Set(c.drivers.slice(4).map((d) => d.id)));
      expect(
        (await c.notices(c.request.id)).filter((n) => n.isActive),
      ).toHaveLength(4);
    });

    it('one concurrent acceptance wins and retires every competing invitation and queued alert', async () => {
      const c = await prepare();
      const first = await c.offers(c.request.id);
      const results = await Promise.allSettled(
        first.map((o) => c.dispatch.respond(o.driverId, o.id, 'accept')),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rows = await c.offers(c.request.id);
      expect(rows.filter((o) => o.status === 'accepted')).toHaveLength(1);
      expect(rows.filter((o) => o.status === 'cancelled')).toHaveLength(3);
      expect(rows.filter((o) => o.status === 'pending')).toHaveLength(0);
      expect(
        (await c.notices(c.request.id)).filter(
          (n) => n.isActive && n.data?.ringAlert,
        ),
      ).toHaveLength(0);
      for (const n of (await c.notices(c.request.id)).filter(
        (n) => n.data?.ringAlert,
      ))
        expect(await isDeliverable(n)).toBe(false);
      const selected = await c.db
        .getRepository(TripRequest)
        .findOneByOrFail({ id: c.request.id });
      expect(selected.selectedDriverId).toBe(
        rows.find((o) => o.status === 'accepted')!.driverId,
      );
      await c.relay.advance(c.request.id);
      expect(await c.offers(c.request.id)).toHaveLength(4);
    });

    it('expires a wave, rejects late responses, and recovers the next group through SQL during Redis failure', async () => {
      const c = await prepare();
      const first = await c.offers(c.request.id);
      await c.db.query(
        `UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second' WHERE "requestId"=$1`,
        [c.request.id],
      );
      jest
        .spyOn(c.queue, 'claimDue')
        .mockRejectedValue(new Error('isolated Redis outage'));
      await c.relay.deadlines();
      const rows = await c.offers(c.request.id);
      expect(rows.filter((o) => o.status === 'expired')).toHaveLength(4);
      expect(rows.filter((o) => o.status === 'pending')).toHaveLength(4);
      await expect(
        c.dispatch.respond(first[0].driverId, first[0].id, 'accept'),
      ).rejects.toThrow();
      await expect(
        assertSequentialInvitation(c.db.manager, c.request, first[0].driverId),
      ).rejects.toThrow();
    });

    it('never exceeds four invitations with concurrent allocators or five slot values', async () => {
      const c = await prepare(10);
      const other = new SequentialDispatchService(
        c.db,
        c.config,
        c.queue,
        c.notifications as NotificationService,
        c.changes as RideAlertChanges,
      );
      await Promise.all([
        c.relay.advance(c.request.id),
        other.advance(c.request.id),
      ]);
      expect(await c.offers(c.request.id)).toHaveLength(4);
      const vehicle = await c.db
        .getRepository(Vehicle)
        .findOneByOrFail({ ownerId: c.drivers[4].id });
      const insert = (slot: number) =>
        c.db.query(
          `INSERT INTO trip_request_dispatch_offers
        (id,"requestId","driverId","vehicleId",seats,"expiresAt",sequential,"waveSlot")
        VALUES ($1,$2,$3,$4,1,now()+interval '40 seconds',true,$5)`,
          [randomUUID(), c.request.id, c.drivers[4].id, vehicle.id, slot],
        );
      await expect(insert(5)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(1)).rejects.toMatchObject({ code: '23505' });
      await expect(
        c.db.transaction((m) =>
          new FourDriverDispatchWaves1780000123000().down(m.queryRunner!),
        ),
      ).rejects.toThrow('Drain live');
    });

    it('fences concurrent in-app acceptance preparations and a passenger counteroffer', async () => {
      const c = await prepare(4, false);
      const first = await c.offers(c.request.id);
      const results = await Promise.allSettled(
        first.map((o) =>
          claimRequestAcceptance(c.db.manager, c.request, o.driverId),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const pending = (await c.offers(c.request.id)).filter(
        (o) => o.status === 'pending',
      );
      expect(pending).toHaveLength(1);
      expect(pending[0].phase).toBe('accepting');
      const loser = first.find((o) => o.driverId !== pending[0].driverId)!;
      await expect(
        c.db.transaction(async (manager) => {
          const r = await manager.findOneOrFail(TripRequest, {
            where: { id: c.request.id },
            lock: { mode: 'pessimistic_write' },
          });
          await startPassengerDecision(manager, r, loser.driverId);
        }),
      ).rejects.toThrow();
    });

    it('a counteroffer silences the other three and prevents their quick acceptance', async () => {
      const c = await prepare();
      const first = await c.offers(c.request.id);
      await c.db.transaction(async (manager) => {
        const r = await manager.findOneOrFail(TripRequest, {
          where: { id: c.request.id },
          lock: { mode: 'pessimistic_write' },
        });
        await startPassengerDecision(manager, r, first[0].driverId);
      });
      const rows = await c.offers(c.request.id);
      expect(
        rows.filter((o) => o.status === 'pending' && o.phase === 'passenger'),
      ).toHaveLength(1);
      expect(rows.filter((o) => o.status === 'cancelled')).toHaveLength(3);
      await expect(
        c.dispatch.respond(first[1].driverId, first[1].id, 'accept'),
      ).rejects.toThrow();
      expect(
        (await c.notices(c.request.id)).filter(
          (n) => n.isActive && n.data?.ringAlert,
        ),
      ).toHaveLength(0);
    });

    it('keeps a targeted driver exclusive and allows smaller groups when fewer drivers qualify', async () => {
      const c = await prepare(2);
      expect(await c.offers(c.request.id)).toHaveLength(2);
      await c.db
        .getRepository(TripRequest)
        .update(c.request.id, { status: TripRequestStatus.CANCELLED });
      await c.relay.advance(c.request.id);
      const target = await context().request(true, c.drivers[0].id);
      await c.relay.advance(target.id);
      const only = await c.offers(target.id);
      expect(only).toHaveLength(1);
      expect(only[0].driverId).toBe(c.drivers[0].id);
      expect(
        (await c.offers(c.request.id)).every((o) => o.status === 'cancelled'),
      ).toBe(true);
    });

    it('rolls back every invitation if any outbox write fails', async () => {
      const c = context();
      for (let i = 0; i < 4; i++) await c.driver(15.31 + i * 0.0001);
      const r = await c.request(true);
      await c.db.query(
        `ALTER TABLE notifications ADD CONSTRAINT wave_test_failure CHECK (title <> 'Nouvelle commande de trajet')`,
      );
      try {
        expect(await c.relay.advance(r.id)).toBe(false);
        expect(await c.offers(r.id)).toHaveLength(0);
      } finally {
        await c.db.query(
          'ALTER TABLE notifications DROP CONSTRAINT wave_test_failure',
        );
      }
      expect(await c.relay.advance(r.id)).toBe(true);
      expect(await c.offers(r.id)).toHaveLength(4);
    });

    it('does not invite the same driver in two concurrent request waves', async () => {
      const c = context();
      for (let i = 0; i < 8; i++) await c.driver(15.31 + i * 0.0001);
      const a = await c.request(),
        b = await c.request();
      const other = new SequentialDispatchService(
        c.db,
        c.config,
        c.queue,
        c.notifications as NotificationService,
        c.changes as RideAlertChanges,
      );
      await Promise.all([c.relay.advance(a.id), other.advance(b.id)]);
      // An allocator may skip temporarily locked drivers; its next pass retries.
      await c.relay.advance(a.id);
      await other.advance(b.id);
      const rows = [...(await c.offers(a.id)), ...(await c.offers(b.id))];
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.length).toBeLessThanOrEqual(8);
      expect(new Set(rows.map((o) => o.driverId)).size).toBe(rows.length);
      expect((await c.offers(a.id)).length).toBeLessThanOrEqual(4);
      expect((await c.offers(b.id)).length).toBeLessThanOrEqual(4);
    });

    it('starts only the receiving driver response window and waits for the last pending driver', async () => {
      const c = await prepare();
      const first = await c.offers(c.request.id);
      const n = (await c.notices(c.request.id)).find(
        (n) => n.userId === first[0].driverId,
      )!;
      const receive = () =>
        c.db.transaction((m) =>
          startReceivedResponseWindow(m, first[0].driverId, n.id),
        );
      const receipt = await receive();
      expect(receipt?.offerId).toBe(first[0].id);
      expect((await receive())?.expiresAt).toBe(receipt!.expiresAt);
      const states = await c.db.query<
        { driverId: string; responseStartedAt: Date | null }[]
      >(
        'SELECT "driverId", "responseStartedAt" FROM trip_request_dispatch_offers WHERE "requestId"=$1',
        [c.request.id],
      );
      expect(states.filter((o) => o.responseStartedAt)).toHaveLength(1);
      await c.db.query(
        `UPDATE trip_request_dispatch_offers SET "expiresAt"=now()-interval '1 second'
        WHERE "requestId"=$1 AND "driverId"<>$2`,
        [c.request.id, first[0].driverId],
      );
      await c.relay.advance(c.request.id);
      expect(await c.offers(c.request.id)).toHaveLength(4);
      expect(
        (await c.offers(c.request.id)).filter((o) => o.status === 'pending'),
      ).toHaveLength(1);
      await c.dispatch.respond(first[0].driverId, first[0].id, 'decline');
      expect(await receive()).toBeUndefined();
      expect(
        (await c.offers(c.request.id)).filter((o) => o.status === 'pending'),
      ).toHaveLength(4);
    });

    it('allows a drained migration rollback and reapplication without changing history', async () => {
      const c = await prepare(4);
      await c.db
        .getRepository(TripRequest)
        .update(c.request.id, { status: TripRequestStatus.CANCELLED });
      await c.relay.advance(c.request.id);
      await c.db.transaction((m) =>
        new FourDriverDispatchWaves1780000123000().down(m.queryRunner!),
      );
      await c.db.transaction((m) =>
        new FourDriverDispatchWaves1780000123000().up(m.queryRunner!),
      );
      expect(
        (await c.offers(c.request.id)).filter((o) => o.status === 'cancelled'),
      ).toHaveLength(4);
    });
  });
}
