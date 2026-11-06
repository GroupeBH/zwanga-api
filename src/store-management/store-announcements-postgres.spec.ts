import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AddAppUpdates1780000049000 } from '../database/migrations/1780000049000-AddAppUpdates';
import { AddStoreManagement1780000077000 } from '../database/migrations/1780000077000-AddStoreManagement';
import { AddStoreAdministration1780000078000 } from '../database/migrations/1780000078000-AddStoreAdministration';
import { AnonymousUpdateInstallations1780000092000 } from '../database/migrations/1780000092000-AnonymousUpdateInstallations';
import { AutomaticStoreUpdateAnnouncements1780000112000 } from '../database/migrations/1780000112000-AutomaticStoreUpdateAnnouncements';
import { AppUpdatesService } from '../app-updates/app-updates.service';
import {
  AppUpdateDispatchService,
  isAppUpdateDeliverable,
} from '../app-updates/app-update-dispatch.service';
import { InstallationUpdatesService } from '../app-updates/installation-updates.service';
import { InstallationUpdateDispatchService } from '../app-updates/installation-update-dispatch.service';
import { installationUpdateToken } from '../app-updates/installation-update.policy';
import { STORE_ENTITIES, StoreSyncJob } from './store.entities';
import { StoreConfig } from './store.config';
import { StoreRepository } from './store.repository';
import { StoreReleaseAnnouncementsService } from './store-release-announcements.service';
import { StorePlatform, StoreProviderError } from './store.types';

const pgBin = process.env.APP_UPDATES_TEST_POSTGRES_BIN;
(pgBin ? describe : describe.skip)(
  'Store-triggered updates on isolated PostgreSQL',
  () => {
    const cluster = new IsolatedPostgres(pgBin!);
    const config = new ConfigService({
      STORE_MANAGEMENT_ENABLED: 'true',
      APP_UPDATES_ENABLED: 'true',
      APP_UPDATES_FROM_STORES_ENABLED: 'true',
      STORE_GOOGLE_PACKAGE_NAME: 'com.test',
      STORE_APPLE_APP_ID: '123',
    });
    const schema = new AutomaticStoreUpdateAnnouncements1780000112000();
    let db: DataSource,
      repository: StoreRepository,
      bridge: StoreReleaseAnnouncementsService;
    let updates: AppUpdatesService;
    const user = randomUUID();
    const android = (build = '175', status = 'completed') => ({
      track: 'production',
      releases: [
        {
          name: 'Not a version',
          status,
          versionCodes: [build],
          userFraction: null,
          countryTargeting: null,
        },
      ],
    });
    const apple = {
      platform: 'IOS',
      versionString: '1.10',
      buildVersion: '20',
      appStoreState: 'READY_FOR_DISTRIBUTION',
      phasedReleaseState: null,
    };

    beforeAll(async () => {
      db = await cluster.start();
      db.setOptions({ entities: STORE_ENTITIES });
      await (
        db as unknown as { buildMetadatas(): Promise<void> }
      ).buildMetadatas();
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users(id uuid PRIMARY KEY, "isActive" boolean NOT NULL DEFAULT true, "fcmToken" text);
      CREATE TABLE notifications(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "eventKey" text UNIQUE,
        "userId" uuid REFERENCES users(id), "fcmToken" text, title text, body text, data jsonb,
        "isAutomatic" boolean, status text, "isActive" boolean)`);
      const q = db.createQueryRunner();
      try {
        for (const migration of [
          new AddAppUpdates1780000049000(),
          new AnonymousUpdateInstallations1780000092000(),
          new AddStoreManagement1780000077000(),
          new AddStoreAdministration1780000078000(),
          schema,
        ])
          await migration.up(q);
      } finally {
        await q.release();
      }
      bridge = new StoreReleaseAnnouncementsService(
        config,
        new StoreConfig(config),
      );
      repository = new StoreRepository(db, bridge);
      updates = new AppUpdatesService(db, config);
    }, 60000);
    afterAll(async () => {
      await cluster.stop();
    });
    beforeEach(async () => {
      await db.query(
        'TRUNCATE notifications,app_store_releases,store_sync_jobs,store_records,store_audit_logs,users CASCADE',
      );
      await db.query(
        'INSERT INTO users(id,"fcmToken") VALUES ($1,\'test-token\')',
        [user],
      );
      await db.query('UPDATE store_integrations SET enabled=true');
    });
    async function prepare(
      content: Record<string, unknown>,
      platform: StorePlatform = 'google',
    ) {
      const appId = platform === 'google' ? 'com.test' : '123';
      await repository.enqueue({
        requestKey: randomUUID(),
        platform,
        appId,
        task: 'catalog',
        lane: 'catalog',
        input: { from: '2026-01-01', to: '2026-01-02' },
        actorId: null,
      });
      const job = (await repository.claim(platform, appId))!;
      await repository.apply(job, {
        replaceKinds: ['release'],
        items: [{ kind: 'release', externalId: 'release', content }],
      });
      return job;
    }
    async function importCatalog(
      content: Record<string, unknown> = android(),
      platform: StorePlatform = 'google',
    ) {
      const job = await prepare(content, platform);
      await repository.finish(job);
      return job;
    }

    it('announces only after a successful, committed catalog, once across retries/workers', async () => {
      const job = await prepare(android());
      expect(await db.query('SELECT count(*) FROM app_store_releases')).toEqual(
        [{ count: '0' }],
      );
      await Promise.all([repository.finish(job), repository.finish(job)]);
      await importCatalog();
      expect(
        await db.query(
          'SELECT source,comparison,build,available FROM app_store_releases',
        ),
      ).toEqual([
        {
          source: 'store',
          comparison: 'native_build',
          build: '175.0.0',
          available: true,
        },
      ]);
      expect(
        await db.query(
          "SELECT count(*) FROM store_audit_logs WHERE action='release.store.publish'",
        ),
      ).toEqual([{ count: '1' }]);
    });
    it('never announces a partially imported/failed catalog', async () => {
      const job = await prepare(android());
      await repository.finish(
        job,
        new StoreProviderError('GOOGLE_TEMPORARY_EDIT_CLEANUP_FAILED'),
      );
      expect(await db.query('SELECT count(*) FROM app_store_releases')).toEqual(
        [{ count: '0' }],
      );
    });
    it('does not announce when the integration was disabled during the catalog request', async () => {
      const job = await prepare(android());
      await db.query(
        "UPDATE store_integrations SET enabled=false WHERE platform='google'",
      );
      await repository.finish(job);
      expect(await db.query('SELECT count(*) FROM app_store_releases')).toEqual(
        [{ count: '0' }],
      );
      expect(
        (await db.getRepository(StoreSyncJob).findOneByOrFail({ id: job.id }))
          .state,
      ).toBe('succeeded');
    });
    it('rolls back job completion if recording the announcement fails, then recovers once', async () => {
      const job = await prepare(android());
      const fail = jest
        .spyOn(bridge, 'catalogSucceeded')
        .mockRejectedValueOnce(new Error('synthetic failure'));
      await expect(repository.finish(job)).rejects.toThrow('synthetic failure');
      expect(
        (await db.getRepository(StoreSyncJob).findOneByOrFail({ id: job.id }))
          .state,
      ).toBe('running');
      fail.mockRestore();
      await repository.finish(job);
      expect(await db.query('SELECT count(*) FROM app_store_releases')).toEqual(
        [{ count: '1' }],
      );
    });
    it('targets older native builds only and stops delivery after an update', async () => {
      await importCatalog();
      const client = {
        platform: 'android' as const,
        version: '99.0',
        build: '174',
        pushToken: 'test-token',
      };
      await updates.register(user, client);
      const release = (await updates.latest(client)).release!;
      expect(release.comparison).toBe('native_build');
      expect(
        (await updates.latest({ ...client, build: '175' })).release,
      ).toBeNull();
      expect(
        (await updates.latest({ ...client, build: '176' })).release,
      ).toBeNull();
      expect(
        (await updates.latest({ ...client, platform: 'ios' })).release,
      ).toBeNull();
      const dispatcher = new AppUpdateDispatchService(db, config);
      await Promise.all([
        dispatcher.enqueueUpdates(),
        new AppUpdateDispatchService(db, config).enqueueUpdates(),
      ]);
      const rows: { body: string }[] = await db.query(
        'SELECT body FROM notifications',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].body).not.toContain('0.0.0');
      expect(await isAppUpdateDeliverable(db.manager, release.id, user)).toBe(
        true,
      );
      await updates.register(user, { ...client, build: '175' });
      expect(await isAppUpdateDeliverable(db.manager, release.id, user)).toBe(
        false,
      );
    });
    it('reuses installation delivery, consent and deduplication without double-pushing the user', async () => {
      await importCatalog();
      const id = randomUUID();
      const installs = new InstallationUpdatesService(db, config);
      const info = {
        platform: 'android' as const,
        version: '1.0',
        build: '174',
        enabled: true,
        pushToken: 'test-token',
        sequence: 1,
      };
      await updates.register(user, info);
      await installs.register(id, 'a'.repeat(64), info);
      const dispatch = new InstallationUpdateDispatchService(db, config);
      await dispatch.enqueue();
      await dispatch.enqueue();
      await new AppUpdateDispatchService(db, config).enqueueUpdates();
      const rows: { data: Record<string, unknown> }[] = await db.query(
        'SELECT data FROM notifications',
      );
      expect(rows).toHaveLength(1);
      expect(await installationUpdateToken(db.manager, rows[0].data)).toBe(
        'test-token',
      );
      await installs.register(id, 'a'.repeat(64), {
        ...info,
        sequence: 2,
        enabled: false,
      });
      expect(
        await installationUpdateToken(db.manager, rows[0].data),
      ).toBeNull();
    });
    it('keeps manual withdrawal effective when the same store version is imported again', async () => {
      await importCatalog();
      const [release]: { id: string }[] = await db.query(
        'SELECT id FROM app_store_releases',
      );
      await updates.withdraw(release.id);
      await importCatalog();
      expect(
        await db.query('SELECT available FROM app_store_releases'),
      ).toEqual([{ available: false }]);
    });
    it('withdraws halted automatic versions, blocks downgrade/replays and announces the next build', async () => {
      await importCatalog();
      await importCatalog(android('175', 'halted'));
      expect(
        await db.query('SELECT available FROM app_store_releases'),
      ).toEqual([{ available: false }]);
      await importCatalog(android('170'));
      await importCatalog(android('175'));
      expect(
        await db.query(
          'SELECT count(*) FROM app_store_releases WHERE available',
        ),
      ).toEqual([{ count: '0' }]);
      await importCatalog(android('176'));
      expect(
        await db.query('SELECT build FROM app_store_releases WHERE available'),
      ).toEqual([{ build: '176.0.0' }]);
      await expect(
        updates.publish(user, {
          platform: 'android',
          version: '9.0',
          build: '174',
          notes: '',
          storeAvailabilityConfirmed: true,
        }),
      ).rejects.toThrow('plus récente');
    });
    it('does not withdraw manual announcements when a catalog has no eligible release', async () => {
      await updates.publish(user, {
        platform: 'android',
        version: '1.0',
        build: '160',
        notes: '',
        storeAvailabilityConfirmed: true,
      });
      await importCatalog(android('175', 'inProgress'));
      expect(
        await db.query('SELECT source,available FROM app_store_releases'),
      ).toEqual([{ source: 'admin', available: true }]);
    });
    it('announces Apple independently with legacy-compatible version/build comparison', async () => {
      await importCatalog(apple, 'apple');
      await importCatalog();
      const result = await updates.latest({
        platform: 'ios',
        version: '1.9',
        build: '500',
      });
      expect(result.release).toMatchObject({
        platform: 'ios',
        version: '1.10.0',
        build: '20.0.0',
        comparison: 'version_build',
      });
      expect(
        (
          await updates.latest({
            platform: 'ios',
            version: '1.10',
            build: '20',
          })
        ).release,
      ).toBeNull();
    });
    it('reverses the migration safely without losing releases or reactivating automatic pushes', async () => {
      await importCatalog();
      const q = db.createQueryRunner();
      try {
        await schema.down(q);
        expect(
          await db.query('SELECT available FROM app_store_releases'),
        ).toEqual([{ available: false }]);
        expect(
          await updates.latest({
            platform: 'android',
            version: '1',
            build: '1',
          }),
        ).toEqual({ enabled: true, release: null });
      } finally {
        await schema.up(q);
        await q.release();
      }
    });
  },
);
