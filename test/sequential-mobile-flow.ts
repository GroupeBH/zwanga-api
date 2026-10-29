import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { DriverDispatchController } from '../src/trip-requests/dispatch/dispatch.controller';
import { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import { SequentialDispatchService } from '../src/trip-requests/dispatch/sequential-dispatch.service';
import { TripRequestsService } from '../src/trip-requests/trip-requests.service';
import { TripRequestsController } from '../src/trip-requests/trip-requests.controller';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { NotificationService } from '../src/notifications/notifications.service';
import { Notification } from '../src/notifications/entities/notification.entity';
import { User, UserRole } from '../src/users/entities/user.entity';
import { Vehicle, VehicleType } from '../src/vehicles/entities/vehicle.entity';
import { DriverOffer } from '../src/trip-requests/entities/driver-offer.entity';
import { TripRequest, TripRequestStatus } from '../src/trip-requests/entities/trip-request.entity';
import { RideNotificationReceipts1780000093000 } from '../src/database/migrations/1780000093000-RideNotificationReceipts';
import { RideDeliveryRecovery1780000094000 } from '../src/database/migrations/1780000094000-RideDeliveryRecovery';

type Context = { db: DataSource; relay: SequentialDispatchService; dispatch: DriverDispatchService;
  notifications: { dispatchUrgentNotifications: jest.Mock; dispatchTransactionalNotifications: jest.Mock };
  driver: (longitude?: number) => Promise<User>; ids: string[]; offers: (id: string) => Promise<any[]> };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function nativeReceipt(data: Record<string, string>) {
  if (!process.env.RIDE_AUDIT_ADB) return { observedAt: new Date().toISOString(), source: 'javascript' };
  const serial = process.env.RIDE_AUDIT_SERIAL ?? 'emulator-5554';
  if (!/^emulator-\d+$/.test(serial)) throw new Error('Only local emulator allowed');
  const shell = (...args: string[]) => execFileSync(process.env.RIDE_AUDIT_ADB!, ['-s', serial, 'shell', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  shell('am', 'broadcast', '-n', 'com.zwanga.audit/.AuditReceiver', '--es', 'operation', 'native-payload',
    '--es', 'payload', Buffer.from(JSON.stringify(data)).toString('base64'));
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    let result: any;
    try { result = JSON.parse(shell('run-as', 'com.zwanga.audit', 'cat', 'files/ride-audit-result.json')); } catch {}
    if (result?.notificationId === data.notificationId) {
      expect(result).toMatchObject({ completed: true, count: 1, actions: 2, restorable: true, receipt: { displayed: true } });
      expect(result.title).toContain('Zwanga'); expect(result.body).toContain('TEST LOCAL');
      return { observedAt: new Date(result.receipt.displayedAt).toISOString(), source: 'native' };
    }
    await sleep(200);
  }
  throw new Error('Native receipt missing');
}

/** Explicit opt-in; the sibling mobile sources are executed, never copied into the backend. */
export function sequentialMobileFlow(context: () => Context) {
  const enabled = process.env.RIDE_AUDIT_MOBILE_ROOT;
  (enabled ? it.each([false, true]) : it.skip.each([false, true]))(
    'local cross-repository flow: HTTP creation, real push publisher, mobile action, relay (timeout=%s)', async timeout => {
      const { db, dispatch, relay, notifications, driver, ids, offers } = context();
      const { rideActionHttpClient } = require(join(enabled!, 'tests/helpers/rideActionHttpClient.cjs'));
      const runner = db.createQueryRunner();
      const migrations = [new RideNotificationReceipts1780000093000(), new RideDeliveryRecovery1780000094000()];
      for (const migration of migrations) await migration.up(runner);
      const wire: any[] = [], deliveries: Promise<unknown>[] = [];
      const realFetch = global.fetch;
      const provider = createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part;
        wire.push({ ...JSON.parse(body).message, receivedAt: Date.now() });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: 'local/fcm-only' }));
      });
      await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
      const providerUrl = `http://127.0.0.1:${(provider.address() as any).port}`;
      let apiUrl = '', app: any;
      const transport = jest.spyOn(global, 'fetch').mockImplementation((url, options) => {
        if (String(url).startsWith('https://fcm.googleapis.com/v1/projects/local-test/')) return realFetch(providerUrl, options);
        if (apiUrl && String(url).startsWith(apiUrl + '/')) return realFetch(url, options);
        throw new Error('External network forbidden in local E2E');
      });
      try {
        const first = await driver(), second = await driver(15.311), third = await driver(15.312);
        const passenger = await driver(15.3101); // Driver acting as passenger: must never ring for own request.
        const outside = await driver(16.3);
        const users = [first, second, third, passenger, outside];
        const delivery = new NotificationService(new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' }),
          db.getRepository(Notification), db.getRepository(User), db.getRepository(TripRequest));
        delivery['firebaseApp'] = { options: { projectId: 'local-test', credential: {
          getAccessToken: async () => ({ access_token: 'local-only', expires_in: 3600 }),
        } } } as any;
        notifications.dispatchUrgentNotifications.mockImplementation(() => {
          const job = delivery.dispatchUrgentNotifications(); deliveries.push(job); return job;
        });
        const requests = new TripRequestsService(db.getRepository(TripRequest), db.getRepository(DriverOffer),
          db.getRepository(User), db.getRepository(Vehicle), {} as never, delivery, {} as never, {} as never,
          {} as never, { getPremiumOverview: async () => ({ isPremium: false, premiumBadgeEnabled: false }) } as never,
          {} as never, {} as never, dispatch);
        const builder = Test.createTestingModule({ imports: [ScheduleModule.forRoot()],
          controllers: [DriverDispatchController, TripRequestsController], providers: [
          { provide: DriverDispatchService, useValue: dispatch }, { provide: TripRequestsService, useValue: requests },
          { provide: SequentialDispatchService, useValue: relay },
        ] });
        const module = await builder.overrideGuard(JwtAuthGuard).useValue({ canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const user = users.find(u => u.id === req.headers['x-local-user']);
          if (!user) return false; req.user = { userId: user.id, role: UserRole.DRIVER }; return true;
        } }).compile();
        app = module.createNestApplication(); app.useLogger(false);
        // Authenticate fixtures before the real role and DTO/ownership checks.
        app.use((req: any, _res: any, next: () => void) => {
          const user = users.find(u => u.id === req.headers['x-local-user']);
          if (user) req.user = { userId: user.id, role: UserRole.DRIVER }; next();
        });
        app.useGlobalGuards(new RolesGuard(new Reflector()));
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
        await app.listen(0, '127.0.0.1'); apiUrl = await app.getUrl();
        const send = async (request: any, userId: string) => {
          const response = await fetch(apiUrl + request.url, { method: request.method ?? 'GET',
            headers: { 'Content-Type': 'application/json', 'x-local-user': userId },
            body: request.body ? JSON.stringify(request.body) : undefined, signal: AbortSignal.timeout(15000) });
          const data = await response.json();
          if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`), { status: response.status });
          return data;
        };
        const clients = users.map(u => rideActionHttpClient(u.id, send));
        for (const client of clients) await client.endpoint('registerDriverNotifications', 6);
        const creationStartedAt = Date.now();
        const created: any = await send({ url: '/trip-requests', method: 'POST', body: {
          departureLocation: 'DEPART TEST LOCAL', arrivalLocation: 'DESTINATION TEST LOCAL',
          departureCoordinates: [15.31, -4.3], arrivalCoordinates: [15.32, -4.3],
          departureDateMin: new Date(Date.now() + 120000).toISOString(),
          departureDateMax: new Date(Date.now() + 2400000).toISOString(),
          numberOfSeats: 1, maxPricePerSeat: 1000, vehicleType: VehicleType.CAR, immediateDispatch: timeout,
        } }, passenger.id);
        ids.push(created.id);
        const messages = () => wire.filter(x => x.data?.tripRequestId === created.id &&
          ['trip_request_nearby', 'driver_dispatch_offer'].includes(x.data?.type));
        const waitFor = async (count: number, manualDrain = true) => {
          const end = Date.now() + 15000;
          while (messages().length < count && Date.now() < end) {
            if (manualDrain) await delivery.dispatchUrgentNotifications();
            await sleep(100);
          }
          expect(messages()).toHaveLength(count); return messages()[count - 1].data;
        };
        const initial = await waitFor(1, false);
        console.log('[local-e2e] HTTP creation to mock FCM first delivery ms=' + (messages()[0].receivedAt - creationStartedAt));
        expect(initial.driverId).toBe(first.id); expect(initial.nativeAlert).toBe('driver-v6');
        const observed = await nativeReceipt(initial);
        expect(await clients[0].endpoint('recordRideNotificationReceipt', {
          notificationId: initial.notificationId, stage: 'displayed', ...observed,
        })).toEqual({ received: true });
        expect(await clients[1].endpoint('recordRideNotificationReceipt', {
          notificationId: initial.notificationId, stage: 'displayed', ...observed,
        })).toEqual({ received: false });
        await expect(send({ url: `/trip-requests/${created.id}` }, second.id)).resolves.toMatchObject({ id: created.id, status: 'pending' });
        const before = (await offers(created.id))[0];
        const waitForExpirationRelay = async (previous: any, expectedCount: number) => {
          // Actual Nest cron + elapsed 40-second deadline. No manual tick/drain,
          // fake timer, mobile timeout callback or SQL deadline manipulation.
          while (Date.now() < previous.expiresAt.getTime() - 1200) {
            expect(await offers(created.id)).toHaveLength(expectedCount - 1); await sleep(500);
          }
          while ((await offers(created.id)).length < expectedCount && Date.now() < previous.expiresAt.getTime() + 10000) {
            await sleep(250);
          }
        };
        if (timeout) {
          // A previous counteroffer must not silence subsequent quick invitations.
          await db.getRepository(TripRequest).update(created.id, { status: TripRequestStatus.OFFERS_RECEIVED });
          await waitForExpirationRelay(before, 2);
        } else {
          const result = await clients[0].act({ data: initial }, 'driver-ignore-nearby');
          expect(result).toMatchObject({ decision: 'decline', confirmed: true });
          expect(clients[0].dismissed).toHaveLength(1);
        }
        const next = await waitFor(2, false);
        expect(next.driverId).toBe(second.id);
        const rows = await offers(created.id);
        expect(rows[0].status).toBe(timeout ? 'expired' : 'declined');
        expect(rows[1].driverId).toBe(second.id);
        if (timeout) {
          const elapsed = messages()[1].receivedAt - before.createdAt.getTime();
          expect(elapsed).toBeGreaterThanOrEqual(40000); expect(elapsed).toBeLessThan(50000);
          console.log('[local-e2e] Real 40-second relay latency ms=' + elapsed);
        }
        const nextReceipt = await nativeReceipt(next);
        await clients[1].endpoint('recordRideNotificationReceipt', {
          notificationId: next.notificationId, stage: 'displayed', ...nextReceipt,
        });
        if (timeout) {
          // The second driver also ignores the request. This crosses the queue's
          // 60-second TTL and verifies rediscovery, not just its first handoff.
          await waitForExpirationRelay(rows[1], 3);
          const last = await waitFor(3, false);
          expect(last.driverId).toBe(third.id);
          expect(new Set(messages().map(m => m.data.notificationId)).size).toBe(3);
          const lastReceipt = await nativeReceipt(last);
          await clients[2].endpoint('recordRideNotificationReceipt', {
            notificationId: last.notificationId, stage: 'displayed', ...lastReceipt,
          });
          const elapsed = messages()[2].receivedAt - rows[1].createdAt.getTime();
          expect(elapsed).toBeGreaterThanOrEqual(40000); expect(elapsed).toBeLessThan(50000);
          console.log('[local-e2e] Second real 40-second relay latency ms=' + elapsed);
          expect((await offers(created.id)).map(o => o.status)).toEqual(['expired', 'expired', 'pending']);
          const result = await clients[2].act({ data: last }, 'driver-accept');
          expect(result).toMatchObject({ confirmed: true, decision: 'accept' });
          // Repeated native action must not send another mutation.
          await clients[2].act({ data: last }, 'driver-accept');
          expect(clients[2].requests.filter((r: any) => r.name === 'respondToDispatchOffer')).toHaveLength(1);
          expect((await db.getRepository(TripRequest).findOneByOrFail({ id: created.id })).selectedDriverId).toBe(third.id);
          await expect(send({ url: `/trip-requests/${created.id}` }, second.id)).rejects.toMatchObject({ status: 404 });
          await relay.deadlines(); await relay.advance(created.id); await delivery.dispatchUrgentNotifications();
          expect(messages()).toHaveLength(3);
        } else {
          // Replaying the first refusal cannot skip the current recipient.
          await clients[0].act({ data: initial }, 'driver-ignore-nearby');
          expect(await offers(created.id)).toHaveLength(2);
          await expect(send({ url: `/trip-requests/${created.id}` }, first.id)).rejects.toMatchObject({ status: 404 });
        }
        expect(messages().some(x => [outside.id, passenger.id].includes(x.data.driverId))).toBe(false);
        expect(await db.query('SELECT * FROM ride_notification_receipts')).toHaveLength(timeout ? 3 : 2);
      } finally {
        await Promise.allSettled(deliveries);
        notifications.dispatchUrgentNotifications.mockImplementation(async () => undefined);
        if (app) await app.close(); transport.mockRestore();
        provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
        for (const migration of migrations.reverse()) await migration.down(runner);
        await runner.release();
      }
    }, 150000);
}
