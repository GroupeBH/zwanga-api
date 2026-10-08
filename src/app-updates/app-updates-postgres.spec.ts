import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AddAppUpdates1780000049000 } from '../database/migrations/1780000049000-AddAppUpdates';
import { AppUpdatesService } from './app-updates.service';
import { AppUpdateDispatchService, isAppUpdateDeliverable } from './app-update-dispatch.service';

// Dedicated disposable cluster only. Never reads an application's connection URL or .env.
const pgBin = process.env.APP_UPDATES_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)('app updates on isolated PostgreSQL', () => {
  let directory: string, source: DataSource, started = false;
  let service: AppUpdatesService, dispatcher: AppUpdateDispatchService;
  const admin = randomUUID(), user = randomUUID();
  const config = { get: () => 'true' } as any;
  const input = { platform: 'android' as const, version: '1.10', build: '20', notes: 'Améliorations', storeAvailabilityConfirmed: true };
  const client = { platform: 'android' as const, version: '1.9', build: '10', pushToken: 'fake-token' };
  const executable = (name: string) => join(pgBin!, process.platform === 'win32' ? name + '.exe' : name);
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'zwanga-app-updates-test-'));
    execFileSync(executable('initdb'), ['-D', directory, '-U', 'updates_test', '-A', 'trust', '--no-locale', '-E', 'UTF8'],
      { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    const port = await new Promise<number>(done => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const value = (server.address() as { port: number }).port; server.close(() => done(value));
      });
    });
    execFileSync(executable('pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'],
      { windowsHide: true, stdio: 'ignore', timeout: 30000 });
    started = true;
    source = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'updates_test', database: 'postgres', synchronize: false, extra: { max: 6 } });
    await source.initialize();
    await source.query(`CREATE TABLE users (id uuid PRIMARY KEY, "isActive" boolean NOT NULL DEFAULT true, "fcmToken" varchar);
      CREATE TABLE notifications (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "eventKey" varchar(200) UNIQUE,
        "userId" uuid REFERENCES users(id), "fcmToken" varchar, title varchar, body text, data jsonb,
        "isAutomatic" boolean, status varchar, "isActive" boolean)`);
    const runner = source.createQueryRunner();
    try { await new AddAppUpdates1780000049000().up(runner); } finally { await runner.release(); }
    service = new AppUpdatesService(source, config);
    dispatcher = new AppUpdateDispatchService(source, config);
  }, 60000);
  beforeEach(async () => {
    await source.query('TRUNCATE notifications, app_update_clients, app_store_releases, users CASCADE');
    await source.query('INSERT INTO users (id, "fcmToken") VALUES ($1, NULL), ($2, $3)', [admin, user, client.pushToken]);
  });
  afterAll(async () => {
    try { if (source?.isInitialized) await source.destroy(); }
    finally {
      if (started || (directory && existsSync(join(directory, 'postmaster.pid')))) {
        execFileSync(executable('pg_ctl'), ['-D', directory, '-m', 'fast', '-w', 'stop'], { windowsHide: true, stdio: 'ignore', timeout: 30000 });
      }
      // Only the uniquely created, resolved test directory may be removed.
      if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep + 'zwanga-app-updates-test-')) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
  it('publishes once under concurrent retries and selects only older clients on the same platform', async () => {
    const [first, second] = await Promise.all([service.publish(admin, input), service.publish(admin, input)]);
    expect(first.id).toBe(second.id);
    const latest = await service.latest(client);
    expect(latest.release?.id).toBe(first.id);
    expect(latest.release).not.toHaveProperty('publishedBy');
    expect((await service.latest({ ...client, platform: 'ios' })).release).toBeNull();
    expect((await service.latest({ ...client, version: '1.10', build: '20' })).release).toBeNull();
    expect((await service.latest({ ...client, version: '1.10', build: '19' })).release?.id).toBe(first.id);
  });
  it('queues exactly once across server workers, then suppresses withdrawn announcements', async () => {
    const release = await service.publish(admin, input);
    await service.register(user, client);
    await Promise.all([dispatcher.enqueueUpdates(), new AppUpdateDispatchService(source, config).enqueueUpdates()]);
    expect(await source.query('SELECT count(*) FROM notifications')).toEqual([{ count: '1' }]);
    expect(await isAppUpdateDeliverable(source.manager, release.id, user)).toBe(true);
    await service.withdraw(release.id);
    expect(await isAppUpdateDeliverable(source.manager, release.id, user)).toBe(false);
    expect((await service.latest(client)).release).toBeNull();
    expect((await service.publish(admin, input)).available).toBe(false);
  });
  it('suppresses after installing the update, changing push token or deactivating the user', async () => {
    const release = await service.publish(admin, input);
    await service.register(user, client);
    await service.register(user, { ...client, version: input.version, build: input.build });
    expect(await isAppUpdateDeliverable(source.manager, release.id, user)).toBe(false);
    await service.register(user, client);
    await source.query('UPDATE users SET "fcmToken" = $1 WHERE id = $2', ['rotated', user]);
    expect(await isAppUpdateDeliverable(source.manager, release.id, user)).toBe(false);
    await service.register(user, { ...client, pushToken: 'rotated' });
    await source.query('UPDATE users SET "isActive" = false WHERE id = $1', [user]);
    expect(await isAppUpdateDeliverable(source.manager, release.id, user)).toBe(false);
    await dispatcher.enqueueUpdates();
    expect(await source.query('SELECT count(*) FROM notifications')).toEqual([{ count: '0' }]);
  });
  it('permits in-app announcements without push permission, without enqueuing a push', async () => {
    await service.publish(admin, input);
    await service.register(user, { ...client, pushToken: undefined });
    await dispatcher.enqueueUpdates();
    expect((await service.latest(client)).release).not.toBeNull();
    expect(await source.query('SELECT count(*) FROM notifications')).toEqual([{ count: '0' }]);
  });
  it('keeps a single active release per platform and rejects downgrade attempts', async () => {
    const previous = await service.publish(admin, input);
    const next = await service.publish(admin, { ...input, version: '1.11' });
    await expect(service.publish(admin, { ...input, version: '1.8' })).rejects.toThrow('plus récente');
    expect((await service.latest(client)).release?.id).toBe(next.id);
    expect(await isAppUpdateDeliverable(source.manager, previous.id, user)).toBe(false);
    expect(await source.query('SELECT count(*) FROM app_store_releases WHERE available = true')).toEqual([{ count: '1' }]);
  });
  it('bounds enqueuing to 100 rows per sweep and advances without duplicates', async () => {
    await service.publish(admin, input);
    await source.query(`INSERT INTO users (id, "fcmToken") SELECT gen_random_uuid(), 'test-batch' FROM generate_series(1, 105)`);
    await source.query(`INSERT INTO app_update_clients ("userId", platform, version, build, "tokenHash")
      SELECT id, 'android', '1.0.0', '1.0.0', encode(sha256(convert_to("fcmToken",'UTF8')),'hex') FROM users WHERE "fcmToken" = 'test-batch'`);
    await dispatcher.enqueueUpdates();
    expect(await source.query('SELECT count(*) FROM notifications')).toEqual([{ count: '100' }]);
    await dispatcher.enqueueUpdates();
    expect(await source.query('SELECT count(*) FROM notifications')).toEqual([{ count: '105' }]);
  });
});
