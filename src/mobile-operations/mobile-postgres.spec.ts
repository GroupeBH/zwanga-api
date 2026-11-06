import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntitySchema } from 'typeorm';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AddAppUpdates1780000049000 } from '../database/migrations/1780000049000-AddAppUpdates';
import { AnonymousUpdateInstallations1780000092000 } from '../database/migrations/1780000092000-AnonymousUpdateInstallations';
import { AddStoreManagement1780000077000 } from '../database/migrations/1780000077000-AddStoreManagement';
import { AddStoreAdministration1780000078000 } from '../database/migrations/1780000078000-AddStoreAdministration';
import { MobileOperations1780000111000 } from '../database/migrations/1780000111000-MobileOperations';
import { InstallationUpdatesService } from '../app-updates/installation-updates.service';
import { MobileInstallationsService } from './mobile-installations.service';
import { MobilePoliciesService } from './mobile-policies.service';
import { MobileCampaignsService } from './mobile-campaigns.service';
import { MobileAnalyticsService } from './mobile-analytics.service';
import { MobileMaintenanceService } from './mobile-maintenance.service';
import { MobileConfig } from './mobile.config';
import {
  MobileInstallationDto,
  MobilePageDto,
  MobilePolicyDto,
  MobileCampaignDto,
} from './mobile.dto';
import { StoreConfig } from '../store-management/store.config';
import {
  drainMobileCampaigns,
  mobileCampaignToken,
  mobileTick,
} from './mobile-campaign-delivery';
import {
  Notification,
  NotificationStatus,
} from '../notifications/entities/notification.entity';
import { saveNotificationResult } from '../notifications/notification-push-claim';
import { installationUpdateToken } from '../app-updates/installation-update.policy';

const bin =
  process.env.MOBILE_TEST_POSTGRES_BIN ?? process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'Mobile Operations on isolated PostgreSQL only',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!),
      migration = new MobileOperations1780000111000();
    let db: DataSource,
      installations: MobileInstallationsService,
      policies: MobilePoliciesService,
      campaigns: MobileCampaignsService,
      maintenance: MobileMaintenanceService;
    const actor = randomUUID(),
      approver = randomUUID(),
      user = randomUUID(),
      other = randomUUID(),
      id = randomUUID(),
      secret = 'a'.repeat(64);
    const settings = new ConfigService({
      MOBILE_OPERATIONS_ENABLED: 'true',
      MOBILE_CAMPAIGNS_ENABLED: 'true',
      STORE_GOOGLE_PACKAGE_NAME: 'com.zwanga',
    });
    const config = new MobileConfig(settings),
      storeConfig = new StoreConfig(settings);
    const access = {
      permissions: jest.fn(async () => [
        'mobile.campaigns.approve',
        'mobile.campaigns.launch',
      ]),
    };
    const input = (sequence = 1): MobileInstallationDto => ({
      platform: 'android',
      version: '1.0.0',
      build: '145',
      sequence,
      enabled: true,
      pushToken: 'synthetic-fcm-token-test',
      environment: 'production',
      pushProvider: 'fcm',
      notificationPermission: 'granted',
      preferences: { updates: true, operational: true, marketing: false },
    });
    const policy = (releaseId: string): MobilePolicyDto => ({
      id: randomUUID(),
      platform: 'android',
      environment: 'production',
      releaseId,
      mode: 'REQUIRED',
      minimumBuild: '146',
      message: 'Installez la nouvelle version.',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.zwanga',
      audience: 'all',
      blockedFeatures: ['accept_request'],
      effectiveAt: new Date(Date.now() - 1000).toISOString(),
      availabilityConfirmed: true,
      availabilityEvidence:
        'Release available to the entire audience, verified in store.',
    });
    const campaign = (): MobileCampaignDto => ({
      id: randomUUID(),
      title: 'Maintenance prévue',
      body: 'Informations de maintenance.',
      kind: 'maintenance',
      audience: { environment: 'production', population: 'all' },
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    beforeAll(async () => {
      db = await cluster.start();
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users(id uuid PRIMARY KEY,role text DEFAULT 'passenger',"isActive" boolean DEFAULT true,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE notifications(id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),"eventKey" varchar(200) UNIQUE,"userId" uuid,"fcmToken" varchar NOT NULL DEFAULT '',title text,body text,data jsonb,
        "isAutomatic" boolean,status varchar,"isActive" boolean,"pushAttempts" int DEFAULT 0,"pushPermanentFailure" boolean DEFAULT false,
        "pushRetryAt" timestamptz,"errorMessage" text,"messageId" varchar,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now());
      CREATE TABLE trips(id uuid PRIMARY KEY,"driverId" uuid,status text,"completedAt" timestamptz);
      CREATE TABLE bookings(id uuid PRIMARY KEY,"tripId" uuid,"passengerId" uuid,status text);`);
      const q = db.createQueryRunner();
      try {
        for (const x of [
          new AddAppUpdates1780000049000(),
          new AnonymousUpdateInstallations1780000092000(),
          new AddStoreManagement1780000077000(),
          new AddStoreAdministration1780000078000(),
          migration,
        ])
          await x.up(q);
      } finally {
        await q.release();
      }
      installations = new MobileInstallationsService(
        db,
        config,
        new InstallationUpdatesService(db, settings),
      );
      policies = new MobilePoliciesService(db, config, storeConfig);
      campaigns = new MobileCampaignsService(db, config, access as any);
      maintenance = new MobileMaintenanceService(db, config, policies);
    });
    afterAll(() => cluster.stop());
    beforeEach(async () => {
      access.permissions.mockResolvedValue([
        'mobile.campaigns.approve',
        'mobile.campaigns.launch',
      ]);
      await db.query(
        `TRUNCATE users,notifications,app_store_releases,app_update_installations,mobile_campaigns,mobile_update_policies,store_alert_rules,store_audit_logs,store_records,mobile_operation_ticks CASCADE`,
      );
      await db.query(
        `INSERT INTO users(id,role) VALUES ($1,'super_admin'),($2,'super_admin'),($3,'driver'),($4,'passenger')`,
        [actor, approver, user, other],
      );
    });
    async function release() {
      return (
        await db.query(
          `INSERT INTO app_store_releases(platform,version,build,"publishedBy") VALUES ('android','2.0.0','150.0.0',$1) RETURNING id`,
          [actor],
        )
      )[0].id;
    }
    async function launch(dto = campaign()) {
      await campaigns.save(actor, dto);
      const approved = await campaigns.action(approver, dto.id, 'approve', {
        revision: 1,
        confirmed: true,
      });
      return campaigns.action(actor, dto.id, 'launch', {
        revision: approved.revision,
        confirmed: true,
      });
    }
    it('registers concurrently exactly once, hides secrets, and rejects stale consent/token updates', async () => {
      const result = await Promise.all([
        installations.register(id, secret, input()),
        installations.register(id, secret, input()),
      ]);
      expect(result.filter((r) => r.registered)).toHaveLength(1);
      await installations.register(id, secret, {
        ...input(3),
        pushToken: 'new-synthetic-token',
        preferences: { updates: false, operational: false, marketing: false },
      });
      await installations.register(id, secret, input(2));
      const [r] = await db.query(
        'SELECT * FROM app_update_installations WHERE id=$1',
        [id],
      );
      expect(r.pushToken).toBe('new-synthetic-token');
      expect(r.mobileMetadata.preferences.updates).toBe(false);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM mobile_installation_days',
          )
        )[0].n,
      ).toBe(1);
      const page = await installations.list(new MobilePageDto());
      expect(page.items[0].pushToken).toBeUndefined();
      expect(page.items[0].secretHash).toBeUndefined();
      await expect(
        installations.register(id, 'b'.repeat(64), input(4)),
      ).rejects.toThrow();
      const releaseId = await release();
      expect(
        await installationUpdateToken(db.manager, {
          installationId: id,
          releaseId,
        }),
      ).toBeNull();
    });
    it('links from JWT identity, handles account switches, fences delayed logout and erases telemetry', async () => {
      await installations.register(id, secret, input());
      await installations.link(id, secret, user, 1);
      await installations.link(id, secret, other, 3);
      expect(await installations.link(id, secret, user, 2, true)).toEqual({
        changed: false,
      });
      await expect(
        installations.link(id, secret, user, 4, true),
      ).rejects.toThrow();
      await installations.link(id, secret, other, 4, true);
      await installations.remove(id, secret);
      await expect(
        installations.register(id, secret, input(9)),
      ).rejects.toThrow();
      expect(
        (await installations.list(new MobilePageDto())).items,
      ).toHaveLength(0);
    });
    it('requires explicit release availability; native builds, not marketing versions, drive policy', async () => {
      const dto = policy(await release());
      const row = await policies.save(actor, dto);
      expect(row.active).toBe(false);
      await expect(
        policies.save(actor, { ...dto, message: 'Changed' }),
      ).rejects.toThrow();
      await policies.activate(
        actor,
        dto.id,
        { revision: 1, confirmed: true },
        true,
      );
      expect(
        await policies.check({
          platform: 'android',
          environment: 'production',
          version: '999.0',
          build: '145',
        }),
      ).toMatchObject({ required: true, blockedFeatures: ['accept_request'] });
      expect(
        await policies.check({
          platform: 'ios',
          environment: 'production',
          version: '1',
          build: '145',
        }),
      ).toMatchObject({ required: false });
      await db.query(`UPDATE app_store_releases SET available=false`);
      expect(
        await policies.check({
          platform: 'android',
          environment: 'production',
          version: '1',
          build: '145',
        }),
      ).toMatchObject({ required: false });
    });
    it('vetoes a contradictory staged rollout and never accepts sensitive blocked operations', async () => {
      const dto = policy(await release());
      await policies.save(actor, dto);
      await db.query(
        `INSERT INTO store_records(platform,"appId",kind,"externalId",content) VALUES ('google','com.zwanga','release','production',$1)`,
        [
          JSON.stringify({
            track: 'production',
            releases: [
              {
                versionCodes: ['150'],
                status: 'inProgress',
                userFraction: 0.1,
              },
            ],
          }),
        ],
      );
      await expect(
        policies.activate(
          actor,
          dto.id,
          { revision: 1, confirmed: true },
          true,
        ),
      ).rejects.toThrow('disponibilité');
    });
    it('requires another approver, atomically queues once across workers, and rechecks consent/token/cancellation', async () => {
      await installations.register(id, secret, input());
      const dto = campaign();
      await campaigns.save(actor, dto);
      await expect(
        campaigns.action(actor, dto.id, 'approve', {
          revision: 1,
          confirmed: true,
        }),
      ).rejects.toThrow();
      const row = await launch(dto);
      await Promise.all([campaigns.enqueue(), campaigns.enqueue()]);
      const [n] = await db.query('SELECT * FROM notifications');
      expect(n).toBeDefined();
      expect((await campaigns.stats(dto.id)).queued).toBe(1);
      expect(await mobileCampaignToken(db.manager, n.data)).toBe(
        input().pushToken,
      );
      await installations.register(id, secret, {
        ...input(2),
        pushToken: 'rotated-fcm-token',
      });
      expect(await mobileCampaignToken(db.manager, n.data)).toBe(
        'rotated-fcm-token',
      );
      await campaigns.opened(id, secret, dto.id);
      await campaigns.opened(id, secret, dto.id);
      expect((await campaigns.stats(dto.id)).instrumentedOpens).toBe(1);
      await installations.register(id, secret, {
        ...input(3),
        preferences: { updates: true, operational: false, marketing: false },
      });
      expect(await mobileCampaignToken(db.manager, n.data)).toBeNull();
      await installations.register(id, secret, input(4));
      await campaigns.action(actor, dto.id, 'cancel', {
        revision: row.revision,
        confirmed: true,
      });
      expect(await mobileCampaignToken(db.manager, n.data)).toBeNull();
    });
    it('does not send promotions without opt-in or trust a declared driver role', async () => {
      await installations.register(id, secret, input());
      const dto = { ...campaign(), kind: 'signup' };
      await campaigns.save(actor, dto);
      expect((await campaigns.preview(dto.id)).eligibleInstallations).toBe(0);
      const driver = {
        ...campaign(),
        audience: { environment: 'production', population: 'driver' },
      };
      await campaigns.save(actor, driver);
      expect((await campaigns.preview(driver.id)).eligibleInstallations).toBe(
        0,
      );
      await installations.link(id, secret, user, 1);
      expect((await campaigns.preview(driver.id)).eligibleInstallations).toBe(
        1,
      );
    });
    it('shares the send budget across replicas, saves fenced results and leaves ride alerts untouched', async () => {
      for (let i = 0; i < 3; i++)
        await installations.register(randomUUID(), secret, {
          ...input(),
          pushToken: `synthetic-token-${i}`,
        });
      const row = await launch();
      await campaigns.enqueue();
      await db.query(
        `INSERT INTO notifications (data,status,"isActive") VALUES ('{"type":"driver_dispatch_offer"}','pending',true)`,
      );
      // Map only the columns used by this worker; no business entities or application config are loaded.
      const source = new DataSource({
        ...db.options,
        entities: [
          new EntitySchema<Notification>({
            name: 'Notification',
            target: Notification,
            tableName: 'notifications',
            columns: {
              id: { type: 'uuid', primary: true },
              eventKey: { type: String, nullable: true },
              userId: { type: 'uuid', nullable: true },
              fcmToken: { type: String },
              title: { type: String },
              body: { type: String },
              data: { type: 'jsonb' },
              isAutomatic: { type: Boolean, nullable: true },
              status: { type: String },
              isActive: { type: Boolean },
              pushAttempts: { type: Number },
              pushPermanentFailure: { type: Boolean },
              pushRetryAt: { type: 'timestamptz', nullable: true },
              errorMessage: { type: String, nullable: true },
              messageId: { type: String, nullable: true },
              createdAt: { type: 'timestamptz', createDate: true },
              updatedAt: { type: 'timestamptz', updateDate: true },
            },
          }),
        ],
      });
      await source.initialize();
      try {
        const repo = source.getRepository(Notification),
          warn = jest.fn();
        const send = jest.fn(async (n: Notification) => {
          n.status = NotificationStatus.SENT;
          n.errorMessage = null;
          return saveNotificationResult(repo, n);
        });
        await Promise.all([
          drainMobileCampaigns(repo, send, warn),
          drainMobileCampaigns(repo, send, warn),
        ]);
        expect(warn).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(2);
        expect((await campaigns.stats(row.id)).providerAccepted).toBe(2);
        expect(
          (
            await db.query(
              `SELECT status FROM notifications WHERE data->>'type'='driver_dispatch_offer'`,
            )
          )[0].status,
        ).toBe('pending');
      } finally {
        await source.destroy();
      }
    });
    it('cancels scheduled work when administrative access is revoked', async () => {
      await installations.register(id, secret, input());
      const row = await launch();
      access.permissions.mockResolvedValue([]);
      await campaigns.enqueue();
      expect(
        (
          await db.query('SELECT state FROM mobile_campaigns WHERE id=$1', [
            row.id,
          ])
        )[0].state,
      ).toBe('cancelled');
      expect(
        (await db.query('SELECT count(*)::int AS n FROM notifications'))[0].n,
      ).toBe(0);
    });
    it('uses one global worker tick across replicas and caches bounded analytics without store calls', async () => {
      const claims = await Promise.all([
        db.transaction((m) => mobileTick(m, 'test', 60)),
        db.transaction((m) => mobileTick(m, 'test', 60)),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await installations.register(id, secret, input());
      const cache = { get: jest.fn(), set: jest.fn() },
        stores = { dashboard: jest.fn() };
      const analytics = new MobileAnalyticsService(
        db,
        config,
        cache as any,
        stores as any,
        storeConfig,
      );
      const data = await analytics.overview(new MobilePageDto());
      expect(data.installations.value.installations).toBe(1);
      expect(stores.dashboard).not.toHaveBeenCalled();
      expect(data.conversions.installationToNewSignupPercent).toBeNull();
      cache.get.mockResolvedValue(data);
      const transaction = jest.spyOn(db, 'transaction');
      try {
        expect(await analytics.overview(new MobilePageDto())).toBe(data);
        expect(transaction).not.toHaveBeenCalled();
        expect(stores.dashboard).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
      }
    });
    it.each([undefined, 'android', 'ios'] as const)(
      'returns an empty overview on the migrated schema without mobile telemetry (platform=%s)',
      async (platform) => {
        const cache = { get: jest.fn(), set: jest.fn() },
          stores = { dashboard: jest.fn() };
        const analytics = new MobileAnalyticsService(
          db,
          config,
          cache as any,
          stores as any,
          storeConfig,
        );
        const query = Object.assign(new MobilePageDto(), {
          from: '2000-01-01',
          to: '2000-01-31',
          platform,
        });
        const data = await analytics.overview(query);
        expect(data.installations.availability).toBe('available');
        expect(data.installations.value).toMatchObject({
          installations: 0,
          anonymous: 0,
          linked: 0,
          reachable: 0,
          firstLinksInPeriod: 0,
        });
        expect(data.adoption.value).toEqual([]);
        expect(data.activity.value).toEqual([]);
        expect(data.retention.value).toEqual([]);
        expect(data.conversions.installationToAccountLinkPercent).toBeNull();
        expect(data.conversions.accountToFirstTripPercent).toBeNull();
        expect(data.stores).toEqual({ availability: 'disabled' });
        expect(stores.dashboard).not.toHaveBeenCalled();
        expect(cache.set).toHaveBeenCalledWith(expect.any(String), data, 60);
      },
    );
    it('confirms and deduplicates monitoring alerts and records resolution', async () => {
      const releaseId = await release(),
        dto = policy(releaseId);
      await policies.save(actor, dto);
      await policies.activate(
        actor,
        dto.id,
        { revision: 1, confirmed: true },
        true,
      );
      await db.query('UPDATE app_store_releases SET available=false');
      await db.query(
        `INSERT INTO store_alert_rules(name,type,threshold,"confirmationMinutes") VALUES ('Mandatory policy conflict','mobile_required_policy_conflict',0,0)`,
      );
      await maintenance.monitor();
      await db.query('DELETE FROM mobile_operation_ticks');
      await maintenance.monitor();
      const rows = await db.query('SELECT * FROM store_alert_events');
      expect(rows).toHaveLength(1);
      await maintenance.resolve(
        actor,
        rows[0].id,
        'Policy disabled for review',
      );
      expect(
        (await maintenance.events(new MobilePageDto())).items[0].resolvedAt,
      ).toBeTruthy();
    });
    it('reverses and reapplies migration without touching legacy installations or accounts', async () => {
      await installations.register(id, secret, input());
      const q = db.createQueryRunner();
      try {
        await migration.down(q);
        expect(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM app_update_installations',
            )
          )[0].n,
        ).toBe(1);
        await migration.up(q);
      } finally {
        await q.release();
      }
      expect(
        (await db.query('SELECT count(*)::int AS n FROM users'))[0].n,
      ).toBe(4);
    });
  },
);
