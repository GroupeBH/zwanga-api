import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AddAppUpdates1780000049000 } from '../database/migrations/1780000049000-AddAppUpdates';
import { AnonymousUpdateInstallations1780000092000 } from '../database/migrations/1780000092000-AnonymousUpdateInstallations';
import { AppUpdatesService } from './app-updates.service';
import {
  AppUpdateDispatchService,
  isAppUpdateDeliverable,
} from './app-update-dispatch.service';
import { InstallationUpdatesService } from './installation-updates.service';
import { InstallationUpdateDispatchService } from './installation-update-dispatch.service';
import { installationUpdateToken } from './installation-update.policy';

const bin = process.env.INSTALLATION_UPDATES_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'installation announcements on disposable PostgreSQL',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    let db: DataSource,
      installations: InstallationUpdatesService,
      releases: AppUpdatesService,
      dispatch: InstallationUpdateDispatchService;
    const config = { get: () => 'true' } as unknown as ConfigService;
    const admin = randomUUID(),
      account = randomUUID(),
      id = randomUUID();
    const secret = 'a'.repeat(64),
      token = 'synthetic-registration-token-one';
    const input = {
      platform: 'android' as const,
      version: '1.0',
      build: '10',
      enabled: true,
      pushToken: token,
      sequence: 1,
    };
    beforeAll(async () => {
      db = await cluster.start();
      await db.query(`CREATE TABLE users (id uuid PRIMARY KEY,"isActive" boolean DEFAULT true,"fcmToken" varchar);
      CREATE TABLE notifications (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"eventKey" varchar(200) UNIQUE,"userId" uuid,
      "fcmToken" varchar,title varchar,body text,data jsonb,"isAutomatic" boolean,status varchar,"isActive" boolean)`);
      const runner = db.createQueryRunner();
      try {
        await new AddAppUpdates1780000049000().up(runner);
        await new AnonymousUpdateInstallations1780000092000().up(runner);
      } finally {
        await runner.release();
      }
      installations = new InstallationUpdatesService(db, config);
      releases = new AppUpdatesService(db, config);
      dispatch = new InstallationUpdateDispatchService(db, config);
    });
    afterAll(() => cluster.stop());
    beforeEach(async () => {
      await db.query(
        'TRUNCATE notifications,app_update_installations,app_update_campaigns,app_update_clients,app_store_releases,users CASCADE',
      );
      await db.query(
        'INSERT INTO users (id,"fcmToken") VALUES ($1,NULL),($2,$3)',
        [admin, account, token],
      );
    });
    const release = () =>
      releases.publish(admin, {
        platform: 'android',
        version: '2',
        build: '20',
        notes: 'Améliorations de test',
        storeAvailabilityConfirmed: true,
      });
    async function records() {
      return db.query<
        {
          eventKey: string;
          userId: string | null;
          data: Record<string, unknown>;
        }[]
      >('SELECT "eventKey","userId",data FROM notifications ORDER BY id');
    }
    it('registers without a user, queues once concurrently, and excludes current builds, other OS and denied consent', async () => {
      await installations.register(id, secret, input);
      await installations.register(randomUUID(), secret, {
        ...input,
        pushToken: 'synthetic-other-platform',
        platform: 'ios',
      });
      await installations.register(randomUUID(), secret, {
        ...input,
        pushToken: 'synthetic-current-build',
        version: '2',
        build: '20',
      });
      await installations.register(randomUUID(), secret, {
        ...input,
        enabled: false,
        pushToken: 'synthetic-opted-out',
      });
      await release();
      await Promise.all([
        dispatch.enqueue(),
        new InstallationUpdateDispatchService(db, config).enqueue(),
      ]);
      const rows = await records();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBeNull();
      expect(await installationUpdateToken(db.manager, rows[0].data)).toBe(
        token,
      );
    });
    it('rejects wrong credentials and token takeover without changing consent', async () => {
      await installations.register(id, secret, input);
      await expect(
        installations.register(id, 'b'.repeat(64), {
          ...input,
          enabled: false,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        installations.register(randomUUID(), secret, input),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db.query('SELECT enabled FROM app_update_installations'),
      ).toEqual([{ enabled: true }]);
    });
    it('refreshes the delivery token and revokes queued and retrying pushes on opt-out', async () => {
      await installations.register(id, secret, input);
      await release();
      await dispatch.enqueue();
      const [row] = await records();
      await installations.register(id, secret, {
        ...input,
        pushToken: 'synthetic-new-registration',
        sequence: 2,
      });
      expect(await installationUpdateToken(db.manager, row.data)).toBe(
        'synthetic-new-registration',
      );
      await installations.register(id, secret, {
        ...input,
        enabled: false,
        pushToken: undefined,
        sequence: 3,
      });
      expect(await installationUpdateToken(db.manager, row.data)).toBeNull();
      await dispatch.enqueue();
      expect(await records()).toHaveLength(1);
    });
    it('suppresses old account-based update work after installation consent takes ownership', async () => {
      const r = await release();
      await releases.register(account, input);
      const legacy = new AppUpdateDispatchService(db, config);
      await legacy.enqueueUpdates();
      expect(await records()).toHaveLength(1);
      await installations.register(id, secret, input);
      expect(await isAppUpdateDeliverable(db.manager, r.id, account)).toBe(
        false,
      );
      await legacy.enqueueUpdates();
      await dispatch.enqueue();
      expect(await records()).toHaveLength(2);
      await installations.register(id, secret, {
        ...input,
        enabled: false,
        sequence: 2,
      });
      expect(await isAppUpdateDeliverable(db.manager, r.id, account)).toBe(
        false,
      );
    });
    it('manual campaigns have durable idempotency and a snapshot audience', async () => {
      await installations.register(id, secret, input);
      const r = await release();
      const body = {
        id: randomUUID(),
        releaseId: r.id,
        title: 'Mise à jour disponible',
        body: 'Améliorations : ouvrez le store.',
      };
      expect(await installations.preview(r.id)).toEqual({
        eligibleInstallations: 1,
      });
      const [a, b] = await Promise.all([
        installations.create(admin, body),
        installations.create(admin, body),
      ]);
      expect(a).toEqual(b);
      await expect(
        installations.create(admin, { ...body, title: 'Autre message' }),
      ).rejects.toMatchObject({ status: 409 });
      await installations.register(randomUUID(), secret, {
        ...input,
        pushToken: 'synthetic-newcomer',
      });
      await dispatch.enqueue();
      await dispatch.enqueue();
      const manual = (await records()).filter((row) => row.data.campaignId);
      expect(manual).toHaveLength(1);
      expect(await installationUpdateToken(db.manager, manual[0].data)).toBe(
        token,
      );
      const history = (await installations.list()) as {
        queued: string;
        sent: string;
      }[];
      expect(history[0]).toMatchObject({ queued: '1', sent: '0' });
      await installations.withdraw(body.id);
      expect(
        await installationUpdateToken(db.manager, manual[0].data),
      ).toBeNull();
    });
    it('withdrawn release, expired campaign, stale installation and completed update prevent late delivery', async () => {
      await installations.register(id, secret, input);
      const r = await release();
      const body = {
        id: randomUUID(),
        releaseId: r.id,
        title: 'Nouvelle version',
        body: 'Votre nouvelle version est disponible.',
      };
      await installations.create(admin, body);
      await dispatch.enqueue();
      const rows = await records(),
        automatic = rows.find((row) => !row.data.campaignId)!,
        manual = rows.find((row) => row.data.campaignId)!;
      await db.query(
        `UPDATE app_update_campaigns SET "createdAt"=now()-interval '8 days'`,
      );
      expect(await installationUpdateToken(db.manager, manual.data)).toBeNull();
      await db.query(
        `UPDATE app_update_installations SET "updatedAt"=now()-interval '91 days'`,
      );
      expect(
        await installationUpdateToken(db.manager, automatic.data),
      ).toBeNull();
      await installations.register(id, secret, {
        ...input,
        version: '2',
        build: '20',
        sequence: 2,
      });
      expect(
        await installationUpdateToken(db.manager, automatic.data),
      ).toBeNull();
      await installations.register(id, secret, { ...input, sequence: 3 });
      await releases.withdraw(r.id);
      expect(
        await installationUpdateToken(db.manager, automatic.data),
      ).toBeNull();
    });
    it('feature switch prevents queuing without losing a previously saved opt-in', async () => {
      await installations.register(id, secret, input);
      await release();
      const disabled = { get: () => 'false' } as unknown as ConfigService;
      await new InstallationUpdateDispatchService(db, disabled).enqueue();
      expect(await records()).toHaveLength(0);
      await expect(
        new InstallationUpdatesService(db, disabled).preview('1'),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        await db.query('SELECT enabled FROM app_update_installations'),
      ).toEqual([{ enabled: true }]);
    });
    it('a delayed older registration cannot reactivate notifications after an opt-out', async () => {
      await installations.register(id, secret, {
        ...input,
        enabled: false,
        sequence: 20,
      });
      expect(
        await installations.register(id, secret, {
          ...input,
          enabled: true,
          sequence: 19,
        }),
      ).toEqual({ registered: false, enabled: false });
      expect(
        await db.query('SELECT enabled,sequence FROM app_update_installations'),
      ).toEqual([{ enabled: false, sequence: '20' }]);
    });
  },
);
