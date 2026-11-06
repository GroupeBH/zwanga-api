import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { StoreConfig } from './store.config';
import { StoreRecord, StoreSyncJob } from './store.entities';
import { StoreAuditLog, StoreIntegration } from './store-operations.entities';
import { storeAnnouncements } from './store-release-announcements.policy';

@Injectable()
export class StoreReleaseAnnouncementsService {
  constructor(
    private readonly config: ConfigService,
    private readonly stores: StoreConfig,
  ) {}

  /** Runs inside the successful catalog job's commit; never sends a push here. */
  async catalogSucceeded(
    manager: EntityManager,
    job: StoreSyncJob,
  ): Promise<void> {
    if (
      !this.stores.enabled ||
      this.config.get('APP_UPDATES_ENABLED') !== 'true' ||
      this.config.get('APP_UPDATES_FROM_STORES_ENABLED') !== 'true' ||
      job.task !== 'catalog' ||
      job.appId !== this.stores.appId(job.platform)
    )
      return;
    // An administrator may disable the integration while the API call runs.
    const integration = await manager.getRepository(StoreIntegration).findOne({
      where: { platform: job.platform },
      lock: { mode: 'pessimistic_read' },
    });
    if (!integration?.enabled) return;
    const platform = job.platform === 'google' ? 'android' : 'ios';
    // Same lock as manual announcements; concurrent automatic/manual writers
    // must not defeat the unique active-platform index or duplicate a release.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `app-update:${platform}`,
    ]);
    const records = await manager.getRepository(StoreRecord).find({
      where: {
        platform: job.platform,
        appId: job.appId,
        kind: 'release',
        isCurrent: true,
      },
      take: 1001,
    });
    if (records.length > 1000) throw new Error('STORE_RELEASE_CATALOG_LIMIT');
    const candidates = storeAnnouncements(
      job.platform,
      records.map((r) => r.content),
    );
    const candidate = candidates[0];
    // Withdraw only system-owned announcements if the successful catalog no
    // longer confirms them. Never withdraw an administrator's announcement.
    const withdrawn: { id: string }[] = await manager.query(
      `WITH withdrawn AS (
         UPDATE app_store_releases SET available=false WHERE platform=$1 AND source='store' AND available
         AND NOT (version=$2 AND build=$3) RETURNING id
       ) SELECT id FROM withdrawn`,
      [platform, candidate?.version ?? '', candidate?.build ?? ''],
    );
    for (const row of withdrawn)
      await manager.getRepository(StoreAuditLog).save({
        actorId: null,
        action: 'release.store.withdraw',
        subjectId: row.id,
        details: { platform, jobId: job.id },
      });
    if (!candidate) return;
    const existing: { id: string }[] = await manager.query(
      `SELECT id FROM app_store_releases WHERE platform=$1 AND $2::text IS NOT NULL AND
       ${
         platform === 'android'
           ? "string_to_array(build,'.')::int[] >= string_to_array($3,'.')::int[]"
           : "(string_to_array(version,'.')::int[] > string_to_array($2,'.')::int[] OR (version=$2 AND string_to_array(build,'.')::int[] >= string_to_array($3,'.')::int[]))"
       } LIMIT 1`,
      [platform, candidate.version, candidate.build],
    );
    // Includes inactive rows: importing again must never reactivate a release
    // withdrawn by an admin, nor roll back to an older version.
    if (existing.length) return;
    await manager.query(
      'UPDATE app_store_releases SET available=false WHERE platform=$1 AND available',
      [platform],
    );
    const [release]: { id: string }[] = await manager.query(
      `INSERT INTO app_store_releases(platform,version,build,notes,source,comparison)
       VALUES ($1,$2,$3,$4,'store',$5) RETURNING id`,
      [
        platform,
        candidate.version,
        candidate.build,
        candidate.notes,
        candidate.comparison,
      ],
    );
    await manager.getRepository(StoreAuditLog).save({
      actorId: null,
      action: 'release.store.publish',
      subjectId: release.id,
      details: {
        platform,
        jobId: job.id,
        appId: job.appId,
        build: candidate.build,
      },
    });
  }
}
