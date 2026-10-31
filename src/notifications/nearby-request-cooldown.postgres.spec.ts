import { TargetTripRequestDriver1780000096000 } from '../database/migrations/1780000096000-TargetTripRequestDriver';
import { MapDriverPriority1780000103000 } from '../database/migrations/1780000103000-MapDriverPriority';
import { RememberDriverRequestRefusals1780000095000 } from '../database/migrations/1780000095000-RememberDriverRequestRefusals';
import { hasRefusedRequest, requestNotRefusedSql } from '../trip-requests/request-refusal';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { postgresTestServerOptions } from '../../test/postgres-test-options';
import { NearbyRequestRingingCooldown1780000087000 } from '../database/migrations/1780000087000-NearbyRequestRingingCooldown';
import type { Notification } from './entities/notification.entity';
type Notice = Pick<Notification, 'id' | 'userId' | 'data'>;
import {
  declineNearbyRequest,
  acknowledgeNearbyRequest,
  prepareNearbyRequestRinging,
  reconcileNearbyRequestCooldowns,
} from './nearby-request-cooldown';

// Explicit opt-in, disposable loopback cluster. Never read DATABASE_URL or .env.
const pgBin = process.env.NEARBY_RING_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'nearby ringtone eligibility without a global penalty on isolated PostgreSQL',
  () => {
    let directory: string,
      started = false,
      db: DataSource;
    const driver = randomUUID(),
      passenger = randomUUID(),
      otherDriver = randomUUID();
    const executable = (name: string) =>
      join(pgBin!, process.platform === 'win32' ? `${name}.exe` : name);
    const run = (name: string, args: string[]) =>
      execFileSync(executable(name), args, {
        windowsHide: true,
        stdio: name === 'pg_ctl' ? 'ignore' : 'pipe',
        timeout: 30_000,
      });
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwanga-nearby-ring-'));
      run('initdb', [
        '-D',
        directory,
        '-U',
        'nearby_ring_test',
        '-A',
        'trust',
        '--no-locale',
        '-E',
        'UTF8',
      ]);
      const port = await new Promise<number>((done) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          server.close(() => done(port));
        });
      });
      started = true;
      run('pg_ctl', [
        '-D',
        directory,
        '-l',
        join(directory, 'postgres.log'),
        '-o',
        postgresTestServerOptions(port),
        '-w',
        'start',
      ]);
      db = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'nearby_ring_test',
        database: 'postgres',
        synchronize: false,
      });
      await db.initialize();
      await db.query(`CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE trip_requests (id uuid PRIMARY KEY, "passengerId" uuid, status text,
        "selectedDriverId" uuid, "tripId" varchar, "departureDateMax" timestamptz,
        "updatedAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE notifications (id uuid PRIMARY KEY, status text, "userId" uuid, "isActive" boolean DEFAULT true, data jsonb);
      CREATE TABLE driver_offers ("tripRequestId" uuid, "driverId" uuid,
        status text NOT NULL DEFAULT 'pending', "updatedAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE trip_request_dispatch_offers ("requestId" uuid, "driverId" uuid, status text, id uuid)`);
      const runner = db.createQueryRunner();
      try {
        await new NearbyRequestRingingCooldown1780000087000().up(runner);
        await new RememberDriverRequestRefusals1780000095000().up(runner);
        await new TargetTripRequestDriver1780000096000().up(runner);
        await new MapDriverPriority1780000103000().up(runner);
        // Minimal schema here; complete migration up/down is covered by dispatch integration tests.
        await db.query(
          'ALTER TABLE nearby_driver_ring_events ADD COLUMN "receivedAt" timestamptz',
        );
      } finally {
        await runner.release();
      }
      await db.query('INSERT INTO users (id) VALUES ($1),($2),($3)', [
        driver,
        passenger,
        otherDriver,
      ]);
    }, 60_000);
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (started) {
        const result = spawnSync(
          executable('pg_ctl'),
          ['-D', directory, 'status'],
          { windowsHide: true, stdio: 'ignore', timeout: 10_000 },
        );
        if (result.status === 0)
          run('pg_ctl', ['-D', directory, '-m', 'immediate', '-w', 'stop']);
        else if (result.status !== 3)
          throw new Error(
            'Cannot confirm disposable PostgreSQL has stopped; keeping its data directory.',
          );
      }
      if (
        directory &&
        resolve(directory).startsWith(
          resolve(tmpdir()) + sep + 'zwanga-nearby-ring-',
        )
      )
        rmSync(directory, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await db.query(
        'TRUNCATE nearby_driver_ring_events, nearby_driver_ring_state, notifications, trip_requests, driver_offers, trip_request_dispatch_offers CASCADE',
      );
    });
    async function create(type = 'trip_request_nearby', owner = driver) {
      const id = randomUUID(),
        requestId = randomUUID();
      await db.query(
        `INSERT INTO trip_requests (id, "passengerId", status, "departureDateMax")
      VALUES ($1,$2,'pending',now() + interval '1 day')`,
        [requestId, passenger],
      );
      await db.query(`INSERT INTO notifications (id, status) VALUES ($1,'pending')`, [id]);
      return {
        id,
        userId: owner,
        data: {
          type,
          driverId: owner,
          passengerId: passenger,
          tripRequestId: requestId,
        },
      };
    }
    const prepare = (notice: Notice) =>
      prepareNearbyRequestRinging(db.manager, notice);
    const sent = (notice: Notice) =>
      db.query(`UPDATE notifications SET status = 'sent' WHERE id = $1`, [
        notice.id,
      ]);
    const refuse = (notice: Notice, owner = driver) =>
      declineNearbyRequest(db.manager, owner, notice.data!.tripRequestId);
    const status = async () => {
      const rows: { missedCount: number; mutedUntil: Date | null }[] =
        await db.query(
          'SELECT * FROM nearby_driver_ring_state WHERE "driverId" = $1',
          [driver],
        );
      return rows[0];
    };
    const expire = () =>
      db.query(
        `UPDATE nearby_driver_ring_events SET "responseDeadline" = now() - interval '1 second',
          "receivedAt" = CASE WHEN "receivedAt" IS NOT NULL THEN now() - interval '20 seconds' ELSE NULL END`,
      );


    it('hides a list refusal persistently for that driver only, without requiring a push', async () => {
      const n = await create();
      await db.query('UPDATE notifications SET "userId" = $2, data = $3 WHERE id = $1', [n.id, driver, n.data]);
      await Promise.all(Array.from({ length: 4 }, () => refuse(n)));
      expect(await hasRefusedRequest(db.manager, driver, n.data.tripRequestId)).toBe(true);
      expect(await hasRefusedRequest(db.manager, otherDriver, n.data.tripRequestId)).toBe(false);
      const visible = (viewer: string) => db.query(`SELECT r.id FROM trip_requests r
        WHERE ${requestNotRefusedSql('r.id', '$1')}`, [viewer]);
      expect(await visible(driver)).toHaveLength(0);
      expect(await prepare(n)).toBe(false);
      expect(await visible(otherDriver)).toHaveLength(1);
      expect(await visible(passenger)).toHaveLength(1);
      expect((await db.query('SELECT status FROM trip_requests'))[0].status).toBe('pending');
      expect((await db.query('SELECT "isActive" FROM notifications'))[0].isActive).toBe(false);
      expect(await db.query('SELECT * FROM trip_request_driver_refusals')).toHaveLength(1);
      await expect(refuse(n, passenger)).rejects.toThrow();
    });

    it.each([true, false])('refusal releases temporary priority but preserves a private target (priority=%s)', async priority => {
      const n = await create();
      await db.query(`UPDATE trip_requests SET "targetDriverId"=$2,
        "targetDriverPriorityUntil"=CASE WHEN $3 THEN now()+interval '5 minutes' ELSE NULL END
        WHERE id=$1`, [n.data.tripRequestId, driver, priority]);
      await db.query('INSERT INTO driver_offers ("tripRequestId", "driverId") VALUES ($1,$2)',
        [n.data.tripRequestId, driver]);
      await refuse(n);
      const [request] = await db.query('SELECT "targetDriverId", "targetDriverPriorityUntil", status FROM trip_requests WHERE id=$1', [n.data.tripRequestId]);
      expect(request).toMatchObject({ targetDriverId: priority ? null : driver, targetDriverPriorityUntil: null, status: 'pending' });
      expect((await db.query('SELECT status FROM driver_offers'))[0].status).toBe('cancelled');
      expect(await hasRefusedRequest(db.manager, driver, n.data.tripRequestId)).toBe(true);
      expect(await hasRefusedRequest(db.manager, otherDriver, n.data.tripRequestId)).toBe(false);
    });

    it('records a deliberate refusal after an ignored ring without hiding merely ignored requests', async () => {
      const n = await create(); await prepare(n); await sent(n);
      await acknowledgeNearbyRequest(db.manager, driver, n.id); await expire();
      await reconcileNearbyRequestCooldowns(db.manager);
      expect(await hasRefusedRequest(db.manager, driver, n.data.tripRequestId)).toBe(false);
      await refuse(n);
      expect(await hasRefusedRequest(db.manager, driver, n.data.tripRequestId)).toBe(true);
      expect((await db.query('SELECT outcome FROM nearby_driver_ring_events'))[0].outcome).toBe('declined');
    });

    it('backfills explicit refusals only, then permits migration rollback and reapply', async () => {
      const refused = await create(), ignored = await create();
      await prepare(refused); await sent(refused); await refuse(refused);
      await prepare(ignored); await sent(ignored); await acknowledgeNearbyRequest(db.manager, driver, ignored.id);
      await expire(); await reconcileNearbyRequestCooldowns(db.manager);
      const runner = db.createQueryRunner(), migration = new RememberDriverRequestRefusals1780000095000();
      try { await migration.down(runner); await migration.up(runner); }
      finally { await runner.release(); }
      expect(await hasRefusedRequest(db.manager, driver, refused.data.tripRequestId)).toBe(true);
      expect(await hasRefusedRequest(db.manager, driver, ignored.data.tripRequestId)).toBe(false);
    });

    it('keeps both nearby families and bookings eligible after more than four distinct refusals', async () => {
      for (let i = 1; i <= 6; i++) {
        const notice = await create(
          i % 2 ? 'trip_request_nearby' : 'driver_dispatch_offer',
        );
        expect(await prepare(notice)).toBe(true);
        await sent(notice);
        const result = await refuse(notice);
        expect(result.missedCount).toBe(0);
        expect(result.mutedUntil).toBeNull();
        expect(await prepare(notice)).toBe(false);
      }
      for (const type of ['trip_request_nearby', 'driver_dispatch_offer'])
        expect(await prepare(await create(type))).toBe(true);
      expect(await prepare(await create('new_booking'))).toBe(true);
      expect(await prepare(await create('booking_response'))).toBe(true);
      expect((await status()).mutedUntil).toBeNull();
    });

    it('keeps ringing after six ignored device receipts followed by a refusal', async () => {
      const ignored: Notice[] = [];
      for (let i = 0; i < 6; i++) {
        const n = await create();
        await prepare(n);
        await sent(n);
        expect(
          await acknowledgeNearbyRequest(db.manager, driver, n.id),
        ).toEqual({ received: true });
        ignored.push(n);
      }
      const failed = await create();
      await prepare(failed);
      await db.query(
        `UPDATE notifications SET status = 'failed' WHERE id = $1`,
        [failed.id],
      );
      const pending = await create();
      await prepare(pending);
      await expire();
      await reconcileNearbyRequestCooldowns(db.manager);
      expect((await status()).missedCount).toBe(0);
      expect((await status()).mutedUntil).toBeNull();
      expect(
        await db.query(
          `SELECT outcome FROM nearby_driver_ring_events WHERE outcome = 'ignored'`,
        ),
      ).toHaveLength(6);
      for (const notice of ignored) expect(await prepare(notice)).toBe(false);
      const refused = await create();
      expect(await prepare(refused)).toBe(true);
      await sent(refused);
      await refuse(refused);
      expect((await status()).missedCount).toBe(0);
      expect(await prepare(await create())).toBe(true);
    });

    it('does not pause a driver for provider-accepted but undelivered pushes', async () => {
      for (let i = 0; i < 5; i++) {
        const n = await create();
        await prepare(n);
        await sent(n);
      }
      await expire();
      await reconcileNearbyRequestCooldowns(db.manager);
      expect((await status()).missedCount).toBe(0);
      expect((await status()).mutedUntil).toBeNull();
    });

    it('accepts only the owning app receipt, including when push failed but realtime arrived', async () => {
      const n = await create();
      await prepare(n);
      await db.query(
        `UPDATE notifications SET status = 'failed' WHERE id = $1`,
        [n.id],
      );
      expect(
        await acknowledgeNearbyRequest(db.manager, otherDriver, n.id),
      ).toEqual({ received: false });
      expect(await acknowledgeNearbyRequest(db.manager, driver, n.id)).toEqual({
        received: true,
      });
      expect(await acknowledgeNearbyRequest(db.manager, driver, n.id)).toEqual({
        received: true,
      });
      await expire();
      await reconcileNearbyRequestCooldowns(db.manager);
      expect((await status()).missedCount).toBe(0);
      expect(await acknowledgeNearbyRequest(db.manager, driver, n.id)).toEqual({
        received: false,
      });
    });

    it('does not penalise a device that received the alert too late to respond', async () => {
      const n = await create();
      await prepare(n);
      await sent(n);
      await acknowledgeNearbyRequest(db.manager, driver, n.id);
      await db.query(
        `UPDATE nearby_driver_ring_events SET "responseDeadline" = now() - interval '1 second'`,
      );
      await reconcileNearbyRequestCooldowns(db.manager);
      expect((await status()).missedCount).toBe(0);
    });

    it('deduplicates concurrent refusals, retries and two notification families for the same order', async () => {
      const n = await create();
      await prepare(n);
      await sent(n);
      await Promise.all(Array.from({ length: 8 }, () => refuse(n)));
      expect((await status()).missedCount).toBe(0);
      expect(await prepare(n)).toBe(false);
      const otherId = randomUUID();
      await db.query(`INSERT INTO notifications (id, status) VALUES ($1,'pending')`, [
        otherId,
      ]);
      expect(await prepare({ ...n, id: otherId })).toBe(false);
      expect((await status()).missedCount).toBe(0);
      await refuse(n, otherDriver); // A request can also be refused from a list without an alert.
    });

    it.each(['trip_request_nearby', 'driver_dispatch_offer'])(
      'immediately rings %s for an already muted driver without reviving an old refusal',
      async (type) => {
        const old = await create();
        await prepare(old);
        await sent(old);
        await refuse(old);
        await db.query(
          `UPDATE nearby_driver_ring_state SET "missedCount" = 4, "mutedUntil" = now() + interval '24 hours' WHERE "driverId" = $1`,
          [driver],
        );
        const fresh = await create(type);
        expect(await prepare(fresh)).toBe(true);
        expect((await status()).missedCount).toBe(0);
        expect((await status()).mutedUntil).toBeNull();
        await sent(fresh);
        await refuse(fresh);
        expect((await status()).missedCount).toBe(0);
        expect(await prepare(old)).toBe(false);
        expect(await prepare(fresh)).toBe(false);
        expect(await prepare(await create(type))).toBe(true);
      },
    );

    it('does not count answers, cancelled/taken orders, another account or self notifications', async () => {
      const answered = await create();
      await prepare(answered);
      await sent(answered);
      await db.query('INSERT INTO driver_offers ("tripRequestId", "driverId") VALUES ($1,$2)', [
        answered.data.tripRequestId,
        driver,
      ]);
      const cancelled = await create();
      await prepare(cancelled);
      await sent(cancelled);
      await db.query(
        `UPDATE trip_requests SET status = 'cancelled' WHERE id = $1`,
        [cancelled.data.tripRequestId],
      );
      await expect(refuse(cancelled)).rejects.toThrow();
      const taken = await create();
      await prepare(taken);
      await sent(taken);
      await db.query(
        `UPDATE trip_requests SET status = 'driver_selected', "selectedDriverId" = $2 WHERE id = $1`,
        [taken.data.tripRequestId, otherDriver],
      );
      await expire();
      await reconcileNearbyRequestCooldowns(db.manager);
      expect((await status()).missedCount).toBe(0);
      expect(
        await prepare({
          ...taken,
          data: { ...taken.data, passengerId: driver },
        }),
      ).toBe(false);
    });

    it('processes concurrent refusals and authoritative answers without muting the next order', async () => {
      const notices: Notice[] = [];
      for (let i = 0; i < 8; i++) {
        const n = await create('driver_dispatch_offer');
        await prepare(n);
        await sent(n);
        notices.push(n);
      }
      for (const [i, n] of notices.entries()) {
        await db.query(
          'INSERT INTO trip_request_dispatch_offers ("requestId", "driverId", status) VALUES ($1,$2,$3)',
          [n.data!.tripRequestId, driver, i === 0 ? 'accepted' : 'declined'],
        );
      }
      await expire();
      await Promise.all([
        reconcileNearbyRequestCooldowns(db.manager),
        reconcileNearbyRequestCooldowns(db.manager),
      ]);
      expect((await status()).missedCount).toBe(0);
      const rows: { outcome: string; count: number }[] = await db.query(
        'SELECT outcome, count(*)::int AS count FROM nearby_driver_ring_events GROUP BY outcome',
      );
      expect(rows.find((row) => row.outcome === 'declined').count).toBe(7);
      expect(rows.find((row) => row.outcome === 'answered').count).toBe(1);
      expect(rows.some((row) => row.outcome === 'muted')).toBe(false);
      expect(await prepare(await create())).toBe(true);
    });

    it('honours each dispatch refusal immediately without blocking subsequent requests', async () => {
      for (let i = 0; i < 6; i++) {
        const n = await create('driver_dispatch_offer');
        expect(await prepare(n)).toBe(true);
        await sent(n);
        await db.query(
          'INSERT INTO trip_request_dispatch_offers ("requestId", "driverId", status) VALUES ($1,$2,$3)',
          [n.data.tripRequestId, driver, 'declined'],
        );
        expect(await prepare(n)).toBe(false);
      }
      expect(await prepare(await create())).toBe(true);
      expect((await status()).missedCount).toBe(0);
    });

    it('resolves old offer-only payloads without allowing another recipient to use them', async () => {
      const n = await create('driver_dispatch_offer'),
        offerId = randomUUID();
      await db.query(
        'INSERT INTO trip_request_dispatch_offers VALUES ($1,$2,$3,$4)',
        [n.data.tripRequestId, driver, 'pending', offerId],
      );
      const legacy = {
        ...n,
        data: {
          type: 'driver_dispatch_offer',
          offerId,
          passengerId: passenger,
        },
      };
      expect(await prepare(legacy)).toBe(true);
      expect(await prepare({ ...legacy, userId: otherDriver })).toBe(false);
      await sent(n);
      await refuse(n);
      expect((await status()).missedCount).toBe(0);
    });

    it('does not extend a response window after a device receipt', async () => {
      const n = await create();
      await prepare(n);
      await db.query(
        `UPDATE notifications SET status = 'failed' WHERE id = $1`,
        [n.id],
      );
      expect(await prepare(n)).toBe(true);
      await sent(n);
      await acknowledgeNearbyRequest(db.manager, driver, n.id);
      await reconcileNearbyRequestCooldowns(db.manager);
      expect((await status()).missedCount).toBe(0);
      const [before]: { responseDeadline: Date }[] = await db.query(
        'SELECT "responseDeadline" FROM nearby_driver_ring_events',
      );
      expect(await prepare(n)).toBe(true);
      const [after]: { responseDeadline: Date }[] = await db.query(
        'SELECT "responseDeadline" FROM nearby_driver_ring_events',
      );
      expect(after.responseDeadline).toEqual(before.responseDeadline);
      await expire();
      await reconcileNearbyRequestCooldowns(db.manager);
      expect((await status()).missedCount).toBe(0);
    });
  },
);
