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
import { lockQueuedCandidates, sequentialCandidates } from '../src/trip-requests/dispatch/sequential-candidates';
import { Trip, TripStatus } from '../src/trips/entities/trip.entity';
import { setDispatchTransactionTimeouts } from '../src/trip-requests/dispatch/dispatch-transaction';
import { receiptConcurrencyFlow } from './receipt-concurrency-flow';

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
    receiptConcurrencyFlow(() => prepare(4));
    it.each([false, true])('discovery exclusions preserve busy ownership and per-request invitation history (ongoing=%s)', async ongoing => {
      const c = context(), drivers = [await c.driver(), await c.driver(15.311), await c.driver(15.312)];
      const wanted = await c.request(true), other = await c.request(true);
      const vehicles = await Promise.all(drivers.map(d => c.db.getRepository(Vehicle).findOneByOrFail({ ownerId: d.id })));
      if (ongoing) {
        for (let i = 0; i < drivers.length; i++) await c.db.getRepository(Trip).save({
          driverId: drivers[i].id, vehicleId: vehicles[i].id, departureLocation: 'A', arrivalLocation: 'B',
          departureDate: new Date(), status: TripStatus.ACTIVE, totalSeats: 4, availableSeats: 3,
          pricePerSeat: 1000, currentLocation: wanted.departurePoint, lastLocationUpdateAt: new Date(),
        });
        await c.db.query('DELETE FROM driver_dispatch_presence');
      }
      const candidates = async (r = wanted) => (await sequentialCandidates(c.db.manager, r)).map(d => d.driverId).sort();
      expect(await candidates()).toEqual(drivers.map(d => d.id).sort());
      const busyId = randomUUID();
      for (const [i, r, status, id] of [[0, other, 'pending', busyId], [1, wanted, 'expired', randomUUID()]] as const)
        await c.db.query(`INSERT INTO trip_request_dispatch_offers
          (id,"requestId","driverId","vehicleId",seats,"expiresAt",sequential,"waveSlot",status)
          VALUES ($1,$2,$3,$4,3,now()+interval '30 seconds',true,1,$5)`,
          [id, r.id, drivers[i].id, vehicles[i].id, status]);
      expect(await candidates()).toEqual([drivers[2].id]);
      expect(await candidates(await c.request(true))).toEqual([drivers[1].id, drivers[2].id].sort());
      await c.db.query("UPDATE trip_request_dispatch_offers SET status='cancelled' WHERE id=$1", [busyId]);
      expect(await candidates()).toEqual([drivers[0].id, drivers[2].id].sort());
    });
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

    it('uses one validation and one outbox insert for a four-driver wave, preserving actual deadlines', async () => {
      const c = context();
      for (let i = 0; i < 4; i++) await c.driver(15.31 + i * 0.0001);
      const r = await c.request(true);
      const sql: string[] = [];
      const create = c.db.createQueryRunner.bind(c.db);
      const spy = jest.spyOn(c.db, 'createQueryRunner').mockImplementation((...args) => {
        const runner = create(...args), query = runner.query.bind(runner);
        runner.query = ((...params: Parameters<typeof runner.query>) => {
          sql.push(String(params[0])); return query(...params);
        }) as typeof runner.query;
        return runner;
      });
      try { expect(await c.relay.advance(r.id)).toBe(true); }
      finally { spy.mockRestore(); }
      expect(sql.filter(q => q.includes('WITH queued_driver AS MATERIALIZED'))).toHaveLength(1);
      expect(sql.filter(q => /^INSERT INTO trip_request_dispatch_offers/.test(q))).toHaveLength(1);
      expect(sql.filter(q => /^INSERT INTO "notifications"/.test(q))).toHaveLength(1);
      expect(sql.filter(q => q.includes('WITH pending AS MATERIALIZED'))).toHaveLength(1);
      expect(sql.filter(q => q.includes('WITH deadlines AS'))).toHaveLength(1);
      const rows = await c.db.query(`SELECT "expiresAt", "deliveryDeadlineAt" FROM trip_request_dispatch_offers WHERE "requestId"=$1`, [r.id]);
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row.deliveryDeadlineAt).toEqual(row.expiresAt);
      expect(await c.notices(r.id)).toHaveLength(4);
    });

    it('skips a locked driver in a bounded wave and rechecks inactive accounts and vehicles', async () => {
      const c = context(), drivers: User[] = [];
      for (let i = 0; i < 5; i++) drivers.push(await c.driver(15.31 + i * 0.0001));
      const r = await c.request(true);
      await c.db.getRepository(User).update(drivers[1].id, { isActive: false });
      await c.db.getRepository(Vehicle).update({ ownerId: drivers[2].id }, { isActive: false });
      const blocker = c.db.createQueryRunner();
      await blocker.connect(); await blocker.startTransaction();
      try {
        await blocker.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [drivers[0].id]);
        const checked = await c.db.transaction(manager => lockQueuedCandidates(manager, r, drivers.map(d => d.id), 4));
        expect(checked.map(row => row.driverId)).toEqual(drivers.slice(1).map(d => d.id));
        expect(checked.map(row => !!row.candidate)).toEqual([false, false, true, true]);
      } finally { await blocker.rollbackTransaction(); await blocker.release(); }
    });

    it('keeps dispatch timeouts local to the transaction on a reused connection', async () => {
      const runner = context().db.createQueryRunner(); await runner.connect();
      try {
        const settings = () => runner.query(`SELECT current_setting('lock_timeout') AS lock,
          current_setting('statement_timeout') AS statement`);
        const original = await settings();
        await runner.startTransaction(); await setDispatchTransactionTimeouts(runner.manager);
        expect(await settings()).toEqual([{ lock: '2s', statement: '5s' }]);
        await runner.commitTransaction(); expect(await settings()).toEqual(original);
        await runner.startTransaction(); await setDispatchTransactionTimeouts(runner.manager);
        await runner.rollbackTransaction(); expect(await settings()).toEqual(original);
      } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
    });

    it('concurrent receipts start one response window and never rewrite it on retries', async () => {
      const c = await prepare(4), offer = (await c.offers(c.request.id))[0];
      const notice = (await c.notices(c.request.id)).find(n => n.userId === offer.driverId)!;
      const results = await Promise.all(Array.from({ length: 6 }, () => c.db.transaction(m =>
        startReceivedResponseWindow(m, offer.driverId, notice.id))));
      expect(results.every(result => !!result)).toBe(true);
      expect(new Set(results.map(result => result!.expiresAt)).size).toBe(1);
      const [before] = await c.db.query(`SELECT xmin::text AS version FROM trip_request_dispatch_offers WHERE id=$1`, [offer.id]);
      expect(await c.db.transaction(m => startReceivedResponseWindow(m, offer.driverId, notice.id)))
        .toEqual(expect.objectContaining({ expiresAt: results[0]!.expiresAt }));
      expect(await c.db.query(`SELECT xmin::text AS version FROM trip_request_dispatch_offers WHERE id=$1`, [offer.id])).toEqual([before]);
      expect(await c.db.transaction(m => startReceivedResponseWindow(m, randomUUID(), notice.id))).toBeUndefined();
      await c.db.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [offer.id]);
      expect(await c.db.transaction(m => startReceivedResponseWindow(m, offer.driverId, notice.id))).toBeUndefined();
    });

    it('does not start a response window for legacy or undelivered-expired offers', async () => {
      const c = await prepare(4), offers = await c.offers(c.request.id), notices = await c.notices(c.request.id);
      await c.db.query(`UPDATE trip_request_dispatch_offers SET "deliveryDeadlineAt"=NULL WHERE id=$1`, [offers[0].id]);
      await c.db.query(`UPDATE trip_request_dispatch_offers SET "deliveryDeadlineAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [offers[1].id]);
      for (const offer of offers.slice(0, 2)) {
        const notice = notices.find(n => n.userId === offer.driverId)!;
        expect(await c.db.transaction(m => startReceivedResponseWindow(m, offer.driverId, notice.id))).toBeUndefined();
      }
      expect(await c.db.query(`SELECT id FROM trip_request_dispatch_offers WHERE "requestId"=$1 AND "responseStartedAt" IS NOT NULL`, [c.request.id])).toEqual([]);
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
