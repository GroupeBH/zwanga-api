import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DataSource, EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { StoreMetric, StoreRecord, StoreSyncJob } from './store.entities';
import { StoreBatch, StorePlatform, StoreProviderError } from './store.types';
import {
  StoreAuditLog,
  StoreIntegration,
  StoreReviewWorkflow,
} from './store-operations.entities';

@Injectable()
export class StoreRepository {
  constructor(readonly db: DataSource) {}

  async enqueue(
    values: Pick<
      StoreSyncJob,
      | 'requestKey'
      | 'platform'
      | 'appId'
      | 'task'
      | 'lane'
      | 'input'
      | 'actorId'
    >,
    manager: EntityManager = this.db.manager,
  ) {
    const repo = manager.getRepository(StoreSyncJob);
    const replay = async () => {
      const existing = await repo.findOneBy({ requestKey: values.requestKey });
      if (!existing) return null;
      if (
        existing.platform !== values.platform ||
        existing.appId !== values.appId ||
        existing.task !== values.task ||
        existing.actorId !== values.actorId ||
        JSON.stringify(existing.input, Object.keys(existing.input).sort()) !==
          JSON.stringify(values.input, Object.keys(values.input).sort())
      )
        throw new ConflictException(
          'Cette clé de requête a déjà été utilisée pour une autre opération.',
        );
      return existing;
    };
    const existing = await replay();
    if (existing) return existing;
    const inserted = await repo
      .createQueryBuilder()
      .insert()
      .values(values)
      .orIgnore()
      .returning('*')
      .execute();
    if (inserted.raw[0]) return repo.create(inserted.raw[0] as StoreSyncJob);
    const same = await replay();
    if (same) return same;
    throw new ConflictException({
      code: 'STORE_SYNC_ALREADY_ACTIVE',
      message:
        'Une opération est déjà en cours sur ce flux. Consultez son historique.',
    });
  }

  async claim(
    platform: StorePlatform,
    appId: string,
  ): Promise<StoreSyncJob | null> {
    return this.db.transaction(async (manager) => {
      // A timed-out public reply must not be replayed: the provider may have accepted it.
      await manager.query(
        `UPDATE store_sync_jobs SET
        state=CASE WHEN task IN ('reply','analytics_request') THEN 'unknown' WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
        "errorCode"='WORKER_LEASE_EXPIRED', "leaseToken"=NULL, "leaseUntil"=NULL,
        "completedAt"=CASE WHEN task IN ('reply','analytics_request') OR attempts >= 5 THEN now() ELSE NULL END
        WHERE platform=$1 AND "appId"=$2 AND state='running' AND "leaseUntil"<now()`,
        [platform, appId],
      );
      const job = await manager
        .getRepository(StoreSyncJob)
        .createQueryBuilder('job')
        .addSelect('job.leaseToken')
        .where('job.platform = :platform AND job.appId = :appId', {
          platform,
          appId,
        })
        .andWhere(
          "job.state = 'pending' AND job.nextAttemptAt <= now() AND job.attempts < 5",
        )
        .orderBy('job.nextAttemptAt', 'ASC')
        .addOrderBy('job.id', 'ASC')
        .take(1)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!job) return null;
      job.state = 'running';
      job.attempts++;
      job.leaseToken = randomUUID();
      job.leaseUntil = new Date(Date.now() + 300000);
      await manager.getRepository(StoreSyncJob).save(job);
      return job;
    });
  }

  async apply(job: StoreSyncJob, batch: StoreBatch): Promise<void> {
    await this.db.transaction(async (manager) => {
      const active = await manager
        .getRepository(StoreSyncJob)
        .createQueryBuilder('job')
        .addSelect('job.leaseToken')
        .where('job.id = :id', { id: job.id })
        .setLock('pessimistic_write')
        .getOne();
      if (
        !active ||
        active.state !== 'running' ||
        active.leaseToken !== job.leaseToken ||
        !active.leaseUntil ||
        active.leaseUntil.getTime() < Date.now()
      )
        throw new StoreProviderError('WORKER_LEASE_LOST');
      const scope = { platform: job.platform, appId: job.appId };
      const records = manager.getRepository(StoreRecord);
      const metrics = manager.getRepository(StoreMetric);
      // Keep stable record IDs (review workflows and version incidents reference them).
      // Provider items carry an observed timestamp; absent releases remain historical.
      if (batch.replaceKinds?.length)
        await records
          .createQueryBuilder()
          .update()
          .set({ isCurrent: false })
          .where('platform=:platform AND "appId"=:appId', scope)
          .andWhere('kind IN (:...kinds)', { kinds: batch.replaceKinds })
          .execute();
      let processed = 0;
      for (const partition of batch.partitions ?? []) {
        const externalId = `partition:${createHash('sha256').update(`${partition.dataset}:${partition.date}`).digest('hex')}`;
        const marker = await records.findOneBy({
          ...scope,
          kind: 'report',
          externalId,
        });
        if (marker && String(marker.content.revision) > partition.revision)
          continue;
        await metrics.delete({
          ...scope,
          dataset: partition.dataset,
          date: partition.date,
        });
        for (let offset = 0; offset < partition.points.length; offset += 500) {
          await metrics.insert(
            partition.points.slice(offset, offset + 500).map((p) => ({
              ...scope,
              dataset: partition.dataset,
              date: partition.date,
              metric: p.metric,
              dimension: p.dimension,
              value: String(p.value),
            })),
          );
        }
        await records.upsert(
          {
            ...scope,
            kind: 'report',
            externalId,
            syncedAt: new Date(),
            content: {
              type: 'partition',
              dataset: partition.dataset,
              date: partition.date,
              revision: partition.revision,
              points: partition.points.length,
            },
          } as unknown as QueryDeepPartialEntity<StoreRecord>,
          ['platform', 'appId', 'kind', 'externalId'],
        );
        processed += partition.points.length;
      }
      for (let offset = 0; offset < (batch.items?.length ?? 0); offset += 100) {
        const items = batch.items!.slice(offset, offset + 100);
        if (
          items.some(
            (i) =>
              !i.externalId ||
              i.externalId.length > 1000 ||
              JSON.stringify(i.content).length > 200000,
          )
        )
          throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
        const versionItems = items.filter(
          (i) => i.kind === 'release' || i.kind === 'build',
        );
        if (versionItems.length) {
          const previous = await records
            .createQueryBuilder('r')
            .where('r.platform=:platform AND r.appId=:appId', scope)
            .andWhere('r.externalId IN (:...ids)', {
              ids: versionItems.map((i) => i.externalId),
            })
            .getMany();
          for (const item of versionItems) {
            const old = previous.find(
              (r) => r.externalId === item.externalId && r.kind === item.kind,
            );
            if (!old || !isDeepStrictEqual(old.content, item.content))
              await manager.getRepository(StoreAuditLog).save({
                actorId: null,
                action: 'version.observed',
                subjectId: old?.id ?? item.externalId,
                details: {
                  platform: job.platform,
                  appId: job.appId,
                  externalId: item.externalId,
                  kind: item.kind,
                  before: old?.content ?? null,
                  after: item.content,
                },
              });
          }
        }
        await records.upsert(
          items.map((i) => ({
            ...scope,
            ...i,
            isCurrent: true,
            syncedAt: new Date(),
          })) as unknown as QueryDeepPartialEntity<StoreRecord>[],
          ['platform', 'appId', 'kind', 'externalId'],
        );
        processed += items.length;
      }
      await manager
        .getRepository(StoreSyncJob)
        .increment({ id: job.id }, 'processed', processed);
      if (processed)
        await manager
          .getRepository(StoreIntegration)
          .update({ platform: job.platform }, { updatedAt: new Date() });
      if (batch.integrationCheck)
        await manager.getRepository(StoreIntegration).update(
          { platform: job.platform },
          {
            checkedAt: new Date(),
            errorCode: Object.values(batch.integrationCheck).some(
              (v) => !v.available,
            )
              ? 'CAPABILITY_CHECK_FAILED'
              : null,
            capabilities: batch.integrationCheck as any,
          },
        );
    });
  }

  async finish(job: StoreSyncJob, error?: StoreProviderError) {
    let state: StoreSyncJob['state'] = 'succeeded';
    if (error)
      state = error.ambiguous
        ? 'unknown'
        : error.retryable && job.attempts < 5
          ? 'pending'
          : /NOT_CONFIGURED|NOT_YET_AVAILABLE|DATA_UNAVAILABLE|REQUEST_REQUIRED/.test(
                error.code,
              )
            ? 'unavailable'
            : 'failed';
    const delay = Math.max(
      error?.retryAfterSeconds ?? 0,
      Math.min(3600, 30 * 2 ** job.attempts),
    );
    await this.db.transaction(async (manager) => {
      const result = await manager
        .getRepository(StoreSyncJob)
        .createQueryBuilder()
        .update()
        .set({
          state,
          errorCode: error?.code ?? null,
          leaseToken: null,
          leaseUntil: null,
          completedAt: state === 'pending' ? null : new Date(),
          nextAttemptAt: new Date(Date.now() + delay * 1000),
        })
        .where('id = :id AND "leaseToken" = :lease AND state = :state', {
          id: job.id,
          lease: job.leaseToken,
          state: 'running',
        })
        .execute();
      if (!result.affected) return;
      if (job.task === 'reply' && state === 'succeeded')
        await manager
          .getRepository(StoreReviewWorkflow)
          .update(
            { recordId: job.input.recordId, publishedJobId: job.id },
            { status: 'responded' },
          );
      if (job.task === 'connection' && error)
        await manager
          .getRepository(StoreIntegration)
          .update(
            { platform: job.platform },
            { checkedAt: new Date(), errorCode: error.code },
          );
      if (job.actorId)
        await manager.getRepository(StoreAuditLog).save({
          actorId: job.actorId,
          action: 'job.' + state,
          subjectId: job.id,
          details: {
            task: job.task,
            platform: job.platform,
            errorCode: error?.code ?? null,
          },
        });
    });
  }
}
