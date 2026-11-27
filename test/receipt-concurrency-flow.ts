import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import type { Notification } from '../src/notifications/entities/notification.entity';
import { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import { claimRequestAcceptance } from '../src/trip-requests/dispatch/request-acceptance';
import { retireRequestInvitations } from '../src/trip-requests/dispatch/retire-request-invitations';
import type { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { prepareNearbyRequestRinging } from '../src/notifications/nearby-request-cooldown';
import { receiptAdmission } from '../src/trip-requests/dispatch/receipt-admission';

type Context = {
  db: DataSource;
  dispatch: DriverDispatchService;
  request: TripRequest;
  offers: (id: string) => Promise<{ id: string; driverId: string }[]>;
  notices: (id: string) => Promise<Notification[]>;
};

/** Real PostgreSQL transactions, deliberately held open to make races deterministic.
 * The actual acknowledgement method runs unchanged, including telemetry and nearby
 * ring updates. Only BEGIN/COMMIT ownership moves to the test's query runner. */
export function receiptConcurrencyFlow(prepare: () => Promise<Context>) {
  describe('receipt concurrency fences', () => {
    const transaction = async (c: Context) => {
      const runner = c.db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query(`SET LOCAL statement_timeout='5s'`);
      const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
      const service: DriverDispatchService = Object.create(c.dispatch);
      Object.assign(service, { db: { transaction: (work: (m: EntityManager) => unknown) => work(runner.manager) } });
      return { runner, pid: Number(pid), service };
    };
    const close = async (runner: QueryRunner) => {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    };
    // Attach the rejection handler immediately; always settle work before releasing
    // its connection, including when an assertion fails while it is SQL-blocked.
    const observe = <T>(work: Promise<T>) => work.then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
    );
    const valueOf = <T>(result: Awaited<ReturnType<typeof observe<T>>>) => {
      if (!result.ok) throw result.error;
      return result.value;
    };
    const waitForBlock = async (db: DataSource, blocker: number, waiter?: number) => {
      const until = Date.now() + 1500;
      do {
        const [{ blocked }] = await db.query(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND ($2::int IS NULL OR pid=$2) AND $1=ANY(pg_blocking_pids(pid))
        ) AS blocked`, [blocker, waiter ?? null]);
        if (blocked) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < until);
      throw new Error('Expected a real PostgreSQL lock wait before releasing the blocker');
    };
    const fixture = async () => {
      const c = await prepare(), offers = await c.offers(c.request.id);
      const notices = await c.notices(c.request.id);
      return { ...c, invitations: offers.map(o => ({ ...o, notice: notices.find(n => n.userId === o.driverId)! })) };
    };

    it('uses three statements and commits or rolls back telemetry, ringing and response window together', async () => {
      const c = await fixture(), o = c.invitations[0];
      expect(await prepareNearbyRequestRinging(c.db.manager, o.notice)).toBe(true);
      expect(await c.dispatch.acknowledgeNotification(c.invitations[1].driverId, o.notice.id))
        .toEqual({ received: false });
      const a = await transaction(c);
      try {
        const queries = jest.spyOn(a.runner, 'query');
        expect((await a.service.acknowledgeNotification(o.driverId, o.notice.id, 'displayed')).received).toBe(true);
        expect(queries).toHaveBeenCalledTimes(3); // timeout, request lock, fresh offer + atomic receipts
        queries.mockRestore();
        expect((await a.runner.query('SELECT "receivedAt" FROM nearby_driver_ring_events WHERE "notificationId"=$1', [o.notice.id]))[0].receivedAt).toBeInstanceOf(Date);
        await a.runner.rollbackTransaction();
      } finally { await close(a.runner); }
      expect(await c.db.query('SELECT 1 FROM ride_notification_receipts WHERE "notificationId"=$1', [o.notice.id])).toEqual([]);
      expect((await c.db.query('SELECT "receivedAt" FROM nearby_driver_ring_events WHERE "notificationId"=$1', [o.notice.id]))[0].receivedAt).toBeNull();
      expect((await c.db.query('SELECT "responseStartedAt" FROM trip_request_dispatch_offers WHERE id=$1', [o.id]))[0].responseStartedAt).toBeNull();
      const first = await c.dispatch.acknowledgeNotification(o.driverId, o.notice.id, 'displayed');
      const [ring] = await c.db.query('SELECT "receivedAt" FROM nearby_driver_ring_events WHERE "notificationId"=$1', [o.notice.id]);
      expect(ring.receivedAt).toBeInstanceOf(Date);
      const retry = await c.dispatch.acknowledgeNotification(o.driverId, o.notice.id, 'received', { audioStage: 'audio_started' });
      expect(retry.responseWindow?.expiresAt).toEqual(first.responseWindow?.expiresAt);
      expect((await c.db.query('SELECT "receivedAt" FROM nearby_driver_ring_events WHERE "notificationId"=$1', [o.notice.id]))[0]).toEqual(ring);
    });

    it.each(['tripRequestId', 'offerId'])('malformed legacy %s stays telemetry only without an unsafe UUID cast', async field => {
      const c = await fixture(), o = c.invitations[0];
      await c.db.query(`UPDATE notifications SET data=jsonb_set(data,ARRAY[$2::text],to_jsonb('invalid-uuid'::text)),
        "eventKey"=CASE WHEN $2='offerId' THEN 'sequential-offer:invalid-uuid' ELSE "eventKey" END WHERE id=$1`,
        [o.notice.id, field]);
      expect(await c.dispatch.acknowledgeNotification(o.driverId, o.notice.id)).toEqual({ received: true });
      expect((await c.db.query('SELECT "responseStartedAt" FROM trip_request_dispatch_offers WHERE id=$1', [o.id]))[0].responseStartedAt).toBeNull();
    });

    it('queued receipts re-read cancellation after admission instead of starting an obsolete response window', async () => {
      const c = await fixture(), o = c.invitations[0];
      let release!: () => void;
      const held = new Promise<void>(r => { release = r; }), gate = receiptAdmission(c.db);
      const busy = Array.from({ length: gate.capacity }, () => gate.run(() => held));
      const pending = observe(c.dispatch.acknowledgeNotification(o.driverId, o.notice.id));
      try {
        expect(gate.snapshot().waiting).toBe(1);
        await c.db.query("UPDATE trip_requests SET status='cancelled' WHERE id=$1", [c.request.id]);
        release(); await Promise.all(busy);
        expect(valueOf(await pending)).toEqual({ received: true });
        const [offer] = await c.db.query('SELECT "responseStartedAt" FROM trip_request_dispatch_offers WHERE id=$1', [o.id]);
        expect(offer.responseStartedAt).toBeNull();
      } finally { release(); await Promise.all(busy); await pending; }
    });

    it('a failed ringing write rolls back telemetry and the response window as well', async () => {
      const c = await fixture(), o = c.invitations[0];
      await prepareNearbyRequestRinging(c.db.manager, o.notice);
      await c.db.query('ALTER TABLE nearby_driver_ring_events ADD CONSTRAINT receipt_atomic_test CHECK ("receivedAt" IS NULL)');
      try {
        await expect(c.dispatch.acknowledgeNotification(o.driverId, o.notice.id)).rejects.toThrow();
        expect(await c.db.query('SELECT 1 FROM ride_notification_receipts WHERE "notificationId"=$1', [o.notice.id])).toEqual([]);
        expect((await c.db.query('SELECT "responseStartedAt" FROM trip_request_dispatch_offers WHERE id=$1', [o.id]))[0].responseStartedAt).toBeNull();
      } finally { await c.db.query('ALTER TABLE nearby_driver_ring_events DROP CONSTRAINT receipt_atomic_test'); }
    });

    it('legacy receipt retries recheck cancellation committed while telemetry was blocked', async () => {
      const c = await fixture(), o = c.invitations[0];
      await prepareNearbyRequestRinging(c.db.manager, o.notice);
      await c.db.query('UPDATE notifications SET "eventKey"=NULL WHERE id=$1', [o.notice.id]);
      const a = await transaction(c), b = await transaction(c);
      let pending: ReturnType<typeof observe<Awaited<ReturnType<DriverDispatchService['acknowledgeNotification']>>>> | undefined;
      try {
        await a.runner.query('INSERT INTO ride_notification_receipts ("notificationId") VALUES ($1)', [o.notice.id]);
        pending = observe(b.service.acknowledgeNotification(o.driverId, o.notice.id));
        await waitForBlock(c.db, a.pid, b.pid);
        await c.db.query("UPDATE trip_requests SET status='cancelled' WHERE id=$1", [c.request.id]);
        await a.runner.commitTransaction();
        expect(valueOf(await pending)).toEqual({ received: true });
        await b.runner.commitTransaction();
        expect((await c.db.query('SELECT "receivedAt" FROM nearby_driver_ring_events WHERE "notificationId"=$1', [o.notice.id]))[0].receivedAt).toBeNull();
      } finally { await close(a.runner); if (pending) await pending; await close(b.runner); }
    });

    it('commits three independent receipts while the first driver still holds the request share lock', async () => {
      const c = await fixture(), first = c.invitations[0], a = await transaction(c);
      try {
        const receipt = await a.service.acknowledgeNotification(first.driverId, first.notice.id);
        expect(receipt.responseWindow?.offerId).toBe(first.id);
        const others = await Promise.all(c.invitations.slice(1).map(o =>
          c.dispatch.acknowledgeNotification(o.driverId, o.notice.id, 'displayed')));
        expect(others.every(r => r.received && r.responseWindow)).toBe(true);
        const committed = await c.db.query(`SELECT o.id FROM trip_request_dispatch_offers o
          WHERE o."requestId"=$1 AND o."responseStartedAt" IS NOT NULL`, [c.request.id]);
        expect(new Set(committed.map(o => o.id))).toEqual(new Set(c.invitations.slice(1).map(o => o.id)));
        await a.runner.commitTransaction();
        const receipts = await c.db.query(`SELECT r."notificationId" FROM ride_notification_receipts r
          JOIN notifications n ON n.id=r."notificationId" WHERE n.data->>'tripRequestId'=$1`, [c.request.id]);
        expect(receipts).toHaveLength(4);
      } finally { await close(a.runner); }
    });

    it.each(['commit', 'rollback'] as const)('serializes same-offer receipts after a first %s without renewing a committed deadline', async outcome => {
      const c = await fixture(), o = c.invitations[0], a = await transaction(c), b = await transaction(c);
      let pending: ReturnType<typeof observe<Awaited<ReturnType<DriverDispatchService['acknowledgeNotification']>>>> | undefined;
      try {
        const first = await a.service.acknowledgeNotification(o.driverId, o.notice.id);
        pending = observe(b.service.acknowledgeNotification(o.driverId, o.notice.id, 'displayed', { source: 'native' }));
        await waitForBlock(c.db, a.pid, b.pid);
        if (outcome === 'commit') await a.runner.commitTransaction();
        else await a.runner.rollbackTransaction();
        const second = valueOf(await pending);
        expect(second.received).toBe(true);
        expect(second.responseWindow?.offerId).toBe(o.id);
        if (outcome === 'commit') expect(second.responseWindow?.expiresAt).toBe(first.responseWindow?.expiresAt);
        await b.runner.commitTransaction();
        const [window] = await c.db.query(`SELECT "responseStartedAt", "expiresAt", xmin::text AS version
          FROM trip_request_dispatch_offers WHERE id=$1`, [o.id]);
        expect(window.responseStartedAt).toBeInstanceOf(Date);
        const retry = await c.dispatch.acknowledgeNotification(o.driverId, o.notice.id, 'received', { audioStage: 'audio_started' });
        expect(retry.responseWindow?.expiresAt).toBe(window.expiresAt.toISOString());
        expect(await c.db.query(`SELECT "responseStartedAt", "expiresAt", xmin::text AS version
          FROM trip_request_dispatch_offers WHERE id=$1`, [o.id])).toEqual([window]);
        const receipts = await c.db.query('SELECT "displayedAt", source, "audioEvents" FROM ride_notification_receipts WHERE "notificationId"=$1', [o.notice.id]);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ displayedAt: expect.any(Date), source: 'native', audioEvents: { audio_started: expect.any(Object) } });
      } finally { await close(a.runner); if (pending) await pending; await close(b.runner); }
    });

    it('blocks even a non-key status UPDATE until the receipt commits', async () => {
      const c = await fixture(), o = c.invitations[0], a = await transaction(c), b = await transaction(c);
      let pending: ReturnType<typeof observe> | undefined;
      try {
        await a.service.acknowledgeNotification(o.driverId, o.notice.id);
        pending = observe(b.runner.query(`UPDATE trip_requests SET status='cancelled' WHERE id=$1`, [c.request.id]));
        await waitForBlock(c.db, a.pid, b.pid);
        await a.runner.commitTransaction(); valueOf(await pending);
        await retireRequestInvitations(b.runner.manager, c.request.id, true);
        await b.runner.commitTransaction();
        expect((await c.dispatch.acknowledgeNotification(o.driverId, o.notice.id)).responseWindow).toBeUndefined();
        expect(await c.db.query(`SELECT id FROM trip_request_dispatch_offers WHERE "requestId"=$1 AND status='pending'`, [c.request.id])).toEqual([]);
      } finally { await close(a.runner); if (pending) await pending; await close(b.runner); }
    });

    it('keeps exactly one winning acceptance after waiting for a receipt', async () => {
      const c = await fixture(), o = c.invitations[0], a = await transaction(c);
      const pending: ReturnType<typeof observe>[] = [];
      try {
        await a.service.acknowledgeNotification(o.driverId, o.notice.id);
        for (const invitation of c.invitations) pending.push(observe(c.dispatch.respond(invitation.driverId, invitation.id, 'accept')));
        await waitForBlock(c.db, a.pid);
        await a.runner.commitTransaction();
        expect((await Promise.all(pending)).filter(r => r.ok)).toHaveLength(1);
        const states = await c.db.query(`SELECT status FROM trip_request_dispatch_offers WHERE "requestId"=$1`, [c.request.id]);
        expect(states.filter(o => o.status === 'accepted')).toHaveLength(1);
        expect(states.filter(o => o.status === 'cancelled')).toHaveLength(3);
        expect((await c.notices(c.request.id)).filter(n => n.isActive && n.data?.ringAlert)).toHaveLength(0);
      } finally { await close(a.runner); await Promise.all(pending); }
    });

    it.each(['cancelled', 'claimed', 'request-expired', 'offer-expired'] as const)(
      'rechecks committed state after waiting for a %s business transaction', async change => {
        const c = await fixture(), o = c.invitations[0], writer = await transaction(c), reader = await transaction(c);
        let pending: ReturnType<typeof observe<Awaited<ReturnType<DriverDispatchService['acknowledgeNotification']>>>> | undefined;
        try {
          await writer.runner.query('SELECT id FROM trip_requests WHERE id=$1 FOR UPDATE', [c.request.id]);
          if (change === 'cancelled') {
            await writer.runner.query(`UPDATE trip_requests SET status='cancelled' WHERE id=$1`, [c.request.id]);
            await retireRequestInvitations(writer.runner.manager, c.request.id, true);
          } else if (change === 'claimed') {
            await claimRequestAcceptance(writer.runner.manager, c.request, o.driverId);
          } else if (change === 'request-expired') {
            await writer.runner.query(`UPDATE trip_requests SET "departureDateMax"=clock_timestamp()-interval '1 second' WHERE id=$1`, [c.request.id]);
          } else {
            await writer.runner.query(`UPDATE trip_request_dispatch_offers SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [o.id]);
          }
          pending = observe(reader.service.acknowledgeNotification(o.driverId, o.notice.id));
          await waitForBlock(c.db, writer.pid, reader.pid);
          await writer.runner.commitTransaction();
          const receipt = valueOf(await pending);
          expect(receipt.received).toBe(true); // Historical telemetry is not an actionable invitation.
          expect(receipt.responseWindow).toBeUndefined();
          await reader.runner.commitTransaction();
          expect(await c.db.query(`SELECT id FROM trip_request_dispatch_offers WHERE id=$1 AND "responseStartedAt" IS NOT NULL`, [o.id])).toEqual([]);
        } finally { await close(writer.runner); if (pending) await pending; await close(reader.runner); }
      },
    );

    it('rolls the response window back with a failed receipt write and permits a clean retry', async () => {
      const c = await fixture(), o = c.invitations[0];
      await c.db.query(`ALTER TABLE ride_notification_receipts ADD CONSTRAINT receipt_test_failure CHECK (source IS DISTINCT FROM 'native')`);
      try {
        await expect(c.dispatch.acknowledgeNotification(o.driverId, o.notice.id, 'displayed', { source: 'native' })).rejects.toThrow();
        expect(await c.db.query(`SELECT id FROM trip_request_dispatch_offers WHERE id=$1 AND "responseStartedAt" IS NOT NULL`, [o.id])).toEqual([]);
        expect(await c.db.query('SELECT 1 FROM ride_notification_receipts WHERE "notificationId"=$1', [o.notice.id])).toEqual([]);
      } finally { await c.db.query('ALTER TABLE ride_notification_receipts DROP CONSTRAINT receipt_test_failure'); }
      expect((await c.dispatch.acknowledgeNotification(o.driverId, o.notice.id)).responseWindow?.offerId).toBe(o.id);
    });
  });
}
