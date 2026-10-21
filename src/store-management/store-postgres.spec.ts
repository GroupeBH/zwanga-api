import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { IsolatedPostgres } from '../../test/isolated-postgres';
import { AddStoreManagement1780000077000 } from '../database/migrations/1780000077000-AddStoreManagement';
import {
  STORE_ENTITIES,
  StoreMetric,
  StoreRecord,
  StoreSyncJob,
} from './store.entities';
import { StoreRepository } from './store.repository';
import { StoreConfig } from './store.config';
import { StoreService } from './store.service';
import { StoreProviderError } from './store.types';
import { AddStoreAdministration1780000078000 } from '../database/migrations/1780000078000-AddStoreAdministration';
import { StoreOperationsService } from './store-operations.service';
import { StoreAccess } from './store.permissions';
import {
  StoreAuditLog,
  StoreReviewWorkflow,
} from './store-operations.entities';
import { UserRole } from '../users/entities/user.entity';
import { StoreAlertsService } from './store-alerts.service';
import { StoreAlertEvent, StoreAlertRule } from './store-operations.entities';

const bin = process.env.AUDIT_TEST_POSTGRES_BIN;
(bin ? describe : describe.skip)(
  'Store Management on disposable PostgreSQL (never application .env)',
  () => {
    jest.setTimeout(90000);
    const cluster = new IsolatedPostgres(bin!);
    const migration = new AddStoreManagement1780000077000();
    const administration = new AddStoreAdministration1780000078000();
    const actor = '10000000-0000-4000-8000-000000000001';
    let db: DataSource, repository: StoreRepository;
    const job = (key = 'request', task: StoreSyncJob['task'] = 'reports') => ({
      requestKey: key,
      platform: 'google' as const,
      appId: 'com.test',
      task,
      lane: task === 'reply' ? 'reviews' : task,
      actorId: actor,
      input: { from: '2026-01-01', to: '2026-01-02' },
    });
    beforeAll(async () => {
      db = await cluster.start();
      db.setOptions({ entities: STORE_ENTITIES });
      await (db as any).buildMetadatas();
      await db.query(`CREATE EXTENSION "uuid-ossp";
      CREATE TABLE users(id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'passenger', email text, "isActive" boolean DEFAULT true, "lastLoginAt" timestamp, "createdAt" timestamp DEFAULT now());
      CREATE TABLE app_update_clients("userId" uuid PRIMARY KEY, platform text);
      CREATE TABLE kyc_documents(id uuid DEFAULT uuid_generate_v4(), "userId" uuid, status text);
      CREATE TABLE bookings(id uuid DEFAULT uuid_generate_v4(), "passengerId" uuid, status text);
      CREATE TABLE trips(id uuid DEFAULT uuid_generate_v4(), "driverId" uuid, status text, "completedAt" timestamptz);`);
      const runner = db.createQueryRunner();
      try {
        await migration.up(runner);
        await administration.up(runner);
      } finally {
        await runner.release();
      }
      repository = new StoreRepository(db);
    });
    afterAll(async () => {
      await cluster.stop();
    });
    beforeEach(async () => {
      await db.query(
        'TRUNCATE store_alert_rules, store_alert_events, store_sync_jobs, store_records, store_metrics, users, kyc_documents, bookings, trips, app_update_clients CASCADE',
      );
      await db.query('INSERT INTO users(id) VALUES ($1)', [actor]);
    });
    it('enqueues concurrent identical requests exactly once and rejects payload reuse', async () => {
      const results = await Promise.all([
        repository.enqueue(job()),
        repository.enqueue(job()),
      ]);
      expect(results[0].id).toBe(results[1].id);
      expect(await db.getRepository(StoreSyncJob).count()).toBe(1);
      await expect(
        repository.enqueue({ ...job(), task: 'reviews' }),
      ).rejects.toThrow('autre opération');
    });
    it('blocks overlapping lanes but isolates another platform and app', async () => {
      await repository.enqueue(job());
      await expect(repository.enqueue(job('other'))).rejects.toThrow(
        'déjà en cours',
      );
      await repository.enqueue({
        ...job('apple'),
        platform: 'apple',
        appId: '123',
      });
      const results = await Promise.all([
        repository.claim('google', 'com.test'),
        repository.claim('google', 'com.test'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repository.claim('apple', '123')).not.toBeNull();
    });
    it('replaces daily snapshots without duplicates or stale dimension rows; rejects older revisions', async () => {
      await repository.enqueue(job());
      const claimed = (await repository.claim('google', 'com.test'))!;
      const partition = {
        dataset: 'installs',
        date: '2026-01-01',
        revision: '2026-01-03',
        points: [
          {
            date: '2026-01-01',
            metric: 'google.device_installs',
            dimension: 'CD',
            value: 4,
          },
          {
            date: '2026-01-01',
            metric: 'google.device_installs',
            dimension: 'FR',
            value: 3,
          },
        ],
      };
      await repository.apply(claimed, { partitions: [partition] });
      await repository.apply(claimed, { partitions: [partition] });
      expect(await db.getRepository(StoreMetric).count()).toBe(2);
      await repository.apply(claimed, {
        partitions: [
          {
            ...partition,
            revision: '2026-01-04',
            points: [{ ...partition.points[0], value: 7 }],
          },
        ],
      });
      await repository.apply(claimed, { partitions: [partition] });
      const metrics = await db.getRepository(StoreMetric).find();
      expect(metrics).toHaveLength(1);
      expect(Number(metrics[0].value)).toBe(7);
    });
    it('fences stale workers and rolls back an invalid batch atomically', async () => {
      await repository.enqueue(job());
      const claimed = (await repository.claim('google', 'com.test'))!;
      await expect(
        repository.apply(claimed, {
          items: [
            { kind: 'review', externalId: 'a', content: { text: 'ok' } },
            { kind: 'review', externalId: '', content: {} },
          ],
        }),
      ).rejects.toThrow('INVALID_PROVIDER_RESPONSE');
      expect(await db.getRepository(StoreRecord).count()).toBe(0);
      await db.query(
        `UPDATE store_sync_jobs SET "leaseToken"=uuid_generate_v4() WHERE id=$1`,
        [claimed.id],
      );
      await expect(
        repository.apply(claimed, {
          items: [{ kind: 'app', externalId: 'a', content: {} }],
        }),
      ).rejects.toThrow('WORKER_LEASE_LOST');
      await repository.finish(claimed);
      expect(
        (
          await db
            .getRepository(StoreSyncJob)
            .findOneByOrFail({ id: claimed.id })
        ).state,
      ).toBe('running');
    });
    it('recovers reads after lease expiry, never replays an uncertain public reply', async () => {
      await repository.enqueue(job());
      const first = (await repository.claim('google', 'com.test'))!;
      await db.query(
        `UPDATE store_sync_jobs SET "leaseUntil"=now()-interval '1 minute' WHERE id=$1`,
        [first.id],
      );
      const second = (await repository.claim('google', 'com.test'))!;
      expect(second.attempts).toBe(2);
      expect(second.leaseToken).not.toBe(first.leaseToken);
      await repository.finish(second);
      await repository.enqueue(job('reply', 'reply'));
      const reply = (await repository.claim('google', 'com.test'))!;
      await db.query(
        `UPDATE store_sync_jobs SET "leaseUntil"=now()-interval '1 minute' WHERE id=$1`,
        [reply.id],
      );
      expect(await repository.claim('google', 'com.test')).toBeNull();
      expect(
        (await db.getRepository(StoreSyncJob).findOneByOrFail({ id: reply.id }))
          .state,
      ).toBe('unknown');
    });
    it('honors Retry-After and ends exhausted retries', async () => {
      await repository.enqueue(job());
      const claimed = (await repository.claim('google', 'com.test'))!;
      await repository.finish(
        claimed,
        new StoreProviderError('PROVIDER_RATE_LIMITED', true, 300),
      );
      const saved = await db
        .getRepository(StoreSyncJob)
        .findOneByOrFail({ id: claimed.id });
      expect(saved.state).toBe('pending');
      expect(saved.nextAttemptAt.getTime()).toBeGreaterThan(
        Date.now() + 290000,
      );
      expect(await repository.claim('google', 'com.test')).toBeNull();
      await db.query(
        `UPDATE store_sync_jobs SET state='running',attempts=5,"leaseUntil"=now()-interval '1 minute' WHERE id=$1`,
        [claimed.id],
      );
      await repository.claim('google', 'com.test');
      expect(
        (
          await db
            .getRepository(StoreSyncJob)
            .findOneByOrFail({ id: claimed.id })
        ).state,
      ).toBe('failed');
    });
    it('calculates cohorts from existing business data without duplicate KYC/trips or admin accounts', async () => {
      const driver = '10000000-0000-4000-8000-000000000002';
      await db.query(`UPDATE users SET "createdAt"='2026-01-01' WHERE id=$1`, [
        actor,
      ]);
      await db.query(
        `INSERT INTO users(id,role,"createdAt") VALUES ($1,'driver','2026-01-01')`,
        [driver],
      );
      await db.query(
        `INSERT INTO kyc_documents("userId",status) VALUES ($1,'approved'),($1,'approved')`,
        [actor],
      );
      await db.query(
        `INSERT INTO bookings("passengerId",status) VALUES ($1,'completed'),($1,'completed')`,
        [actor],
      );
      await db.query(
        `INSERT INTO trips("driverId",status) VALUES ($1,'completed')`,
        [driver],
      );
      const service = new StoreService(
        new StoreConfig(
          new ConfigService({
            STORE_MANAGEMENT_ENABLED: 'true',
            STORE_GOOGLE_PACKAGE_NAME: 'com.test',
          }),
        ),
        repository,
        { get: jest.fn(async () => undefined), set: jest.fn() } as any,
      );
      const result = (await service.dashboard({
        from: '2026-01-01',
        to: '2026-01-02',
      })) as any;
      expect(result.cohorts).toEqual([
        {
          date: '2026-01-01',
          registrations: 2,
          drivers: 1,
          passengers: 1,
          kycSubmitted: 1,
          kycApproved: 1,
          firstTripCompleted: 2,
        },
      ]);
      expect(result.attribution).toBe('aggregate_only');
    });
    it('migration up/down/up leaves existing business data untouched', async () => {
      const runner = db.createQueryRunner();
      try {
        await administration.down(runner);
        await migration.down(runner);
        expect(
          (await db.query('SELECT count(*)::int AS n FROM users'))[0].n,
        ).toBe(1);
        await migration.up(runner);
        await administration.up(runner);
      } finally {
        await runner.release();
      }
      expect(await db.getRepository(StoreMetric).count()).toBe(0);
    });
    it('requires another approver, fences revisions and atomically queues an approved reply', async () => {
      const config = new StoreConfig(
        new ConfigService({
          STORE_MANAGEMENT_ENABLED: 'true',
          STORE_GOOGLE_PACKAGE_NAME: 'com.test',
          STORE_GOOGLE_CLIENT_EMAIL: 'svc@test.iam.gserviceaccount.com',
          STORE_GOOGLE_PRIVATE_KEY: 'configured',
        }),
      );
      const access = new StoreAccess(db, config),
        operations = new StoreOperationsService(config, repository, access);
      const validator = '10000000-0000-4000-8000-000000000003';
      await db.query(`UPDATE users SET role='admin' WHERE id=$1`, [actor]);
      await db.query(`INSERT INTO users(id,role) VALUES ($1,'admin')`, [
        validator,
      ]);
      expect(await access.permissions(actor, UserRole.ADMIN)).not.toContain(
        'store.reviews.reply',
      );
      await operations.grant(actor, validator, { profile: 'validator' });
      expect(await access.permissions(validator, UserRole.ADMIN)).toContain(
        'store.reviews.reply',
      );
      const record = await db.getRepository(StoreRecord).save({
        platform: 'google',
        appId: 'com.test',
        kind: 'review',
        externalId: 'r1',
        content: {},
      });
      await operations.draft(actor, record.id, {
        revision: 0,
        text: 'Merci de votre retour.',
      });
      await expect(
        operations.draft(actor, record.id, { revision: 0, text: 'stale' }),
      ).rejects.toThrow();
      await operations.submit(actor, record.id, 1);
      await expect(
        operations.approve(actor, UserRole.ADMIN, record.id, { revision: 1 }),
      ).rejects.toThrow();
      await expect(
        operations.publish(validator, record.id, {
          revision: 1,
          requestId: validator,
        }),
      ).rejects.toThrow();
      await operations.approve(validator, UserRole.ADMIN, record.id, {
        revision: 1,
      });
      const queued = await operations.publish(validator, record.id, {
        revision: 1,
        requestId: validator,
      });
      expect(
        (
          await operations.publish(validator, record.id, {
            revision: 1,
            requestId: validator,
          })
        ).id,
      ).toBe(queued.id);
      await expect(
        operations.draft(actor, record.id, { revision: 1, text: 'changed' }),
      ).rejects.toThrow();
      expect(await db.getRepository(StoreSyncJob).count()).toBe(1);
      const claimed = (await repository.claim('google', 'com.test'))!;
      await repository.finish(claimed);
      expect(
        (
          await db
            .getRepository(StoreReviewWorkflow)
            .findOneByOrFail({ recordId: record.id })
        ).status,
      ).toBe('responded');
      expect(
        await db.getRepository(StoreAuditLog).count(),
      ).toBeGreaterThanOrEqual(6);
    });
    it('reconciles an uncertain public reply only after a newer matching observation, without a second send', async () => {
      const config = new StoreConfig(
        new ConfigService({
          STORE_MANAGEMENT_ENABLED: 'true',
          STORE_GOOGLE_PACKAGE_NAME: 'com.test',
        }),
      );
      const operations = new StoreOperationsService(
        config,
        repository,
        new StoreAccess(db, config),
      );
      const reply = 'Merci de votre retour.';
      const record = await db.getRepository(StoreRecord).save({
        platform: 'google',
        appId: 'com.test',
        kind: 'review',
        externalId: 'uncertain',
        content: { response: reply },
        syncedAt: new Date('2026-01-01'),
      });
      const queued = await repository.enqueue({
        ...job('reply', 'reply'),
        input: { recordId: record.id, reply, revision: 1 },
      });
      await db.getRepository(StoreReviewWorkflow).save({
        recordId: record.id,
        status: 'approved',
        revision: 1,
        draft: reply,
        publishedJobId: queued.id,
      });
      const claimed = (await repository.claim('google', 'com.test'))!;
      await repository.finish(
        claimed,
        new StoreProviderError(
          'PROVIDER_TEMPORARILY_UNAVAILABLE',
          false,
          0,
          true,
        ),
      );
      await expect(operations.reconcileReply(actor, record.id)).rejects.toThrow(
        'Relancez',
      );
      const completed = (
        await db.getRepository(StoreSyncJob).findOneByOrFail({ id: queued.id })
      ).completedAt!;
      await db.getRepository(StoreRecord).update(record.id, {
        syncedAt: new Date(completed.getTime() + 1000),
        content: { response: 'Un autre texte.' },
      });
      await expect(operations.reconcileReply(actor, record.id)).rejects.toThrow(
        'Relancez',
      );
      await db
        .getRepository(StoreRecord)
        .update(record.id, { content: { response: reply } });
      expect((await operations.reconcileReply(actor, record.id)).status).toBe(
        'responded',
      );
      expect(
        (
          await db
            .getRepository(StoreSyncJob)
            .findOneByOrFail({ id: queued.id })
        ).state,
      ).toBe('succeeded');
      expect(await db.getRepository(StoreSyncJob).count()).toBe(1);
      expect(await repository.claim('google', 'com.test')).toBeNull();
      expect(
        await db
          .getRepository(StoreAuditLog)
          .countBy({ action: 'review.reconciled' }),
      ).toBe(1);
    });
    it('deduplicates concurrent alerts, audits acknowledgments and preserves business rows during retention', async () => {
      const config = new StoreConfig(
        new ConfigService({
          STORE_MANAGEMENT_ENABLED: 'true',
          STORE_GOOGLE_PACKAGE_NAME: 'com.test',
          STORE_RETENTION_MONTHS: '24',
        }),
      );
      const access = new StoreAccess(db, config),
        alerts = new StoreAlertsService(config, repository, access);
      const operations = new StoreOperationsService(config, repository, access);
      const rule = await operations.rule(actor, null, {
        name: 'Avis négatif',
        platform: 'google',
        type: 'negative_review',
        threshold: 2,
        severity: 'warning',
        enabled: true,
        recipients: [],
        email: false,
      });
      const disabled = await operations.patchRule(actor, rule.id, {
        enabled: false,
      });
      expect(disabled).toMatchObject({
        enabled: false,
        threshold: 2,
        type: 'negative_review',
        platform: 'google',
      });
      await expect(
        operations.patchRule(actor, rule.id, { threshold: 6 }),
      ).rejects.toThrow();
      await operations.patchRule(actor, rule.id, { enabled: true });
      await db.getRepository(StoreRecord).save({
        platform: 'google',
        appId: 'com.test',
        kind: 'review',
        externalId: 'negative',
        content: { rating: 1, text: 'Example' },
      });
      await Promise.all([alerts.evaluate(), alerts.evaluate()]);
      expect(await db.getRepository(StoreAlertEvent).count()).toBe(1);
      const event = await db
        .getRepository(StoreAlertEvent)
        .findOneByOrFail({ platform: 'google' });
      await alerts.acknowledge(actor, event.id);
      expect(
        (await alerts.events({ page: 1, limit: 25 })).items[0].acknowledgedBy,
      ).toBe(actor);
      await db.query(
        `INSERT INTO store_metrics(platform,"appId",dataset,date,metric,dimension,value) VALUES ('google','com.test','installs','2000-01-01','google.device_installs','{}',5)`,
      );
      await alerts.retain();
      expect(await db.getRepository(StoreMetric).count()).toBe(0);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM users'))[0].n,
      ).toBe(1);
    });
    it('keeps catalog references stable and records a version change only once', async () => {
      await repository.enqueue(job('catalog', 'catalog'));
      const claimed = (await repository.claim('google', 'com.test'))!;
      const item = {
        kind: 'release' as const,
        externalId: 'production',
        content: {
          track: 'production',
          releases: [{ status: 'completed', versionCodes: ['145'] }],
        },
      };
      await repository.apply(claimed, { items: [item] });
      const first = await db
        .getRepository(StoreRecord)
        .findOneByOrFail({ externalId: 'production' });
      await repository.apply(claimed, { items: [item] });
      expect(
        (
          await db
            .getRepository(StoreRecord)
            .findOneByOrFail({ externalId: 'production' })
        ).id,
      ).toBe(first.id);
      expect(
        await db
          .getRepository(StoreAuditLog)
          .countBy({ action: 'version.observed' }),
      ).toBe(1);
      await repository.apply(claimed, { items: [], replaceKinds: ['release'] });
      const inactive = await db
        .getRepository(StoreRecord)
        .findOneByOrFail({ id: first.id });
      expect(inactive.isCurrent).toBe(false);
      await repository.apply(claimed, {
        items: [item],
        replaceKinds: ['release'],
      });
      expect(
        (await db.getRepository(StoreRecord).findOneByOrFail({ id: first.id }))
          .isCurrent,
      ).toBe(true);
    });
  },
);
