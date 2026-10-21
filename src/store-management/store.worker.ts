import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StoreConfig } from './store.config';
import { StoreRepository } from './store.repository';
import { GooglePlayProvider } from './google-play.provider';
import { AppleStoreProvider } from './apple-store.provider';
import {
  day,
  STORE_PLATFORMS,
  STORE_TASKS,
  StorePlatform,
  StoreProviderError,
  StoreTask,
} from './store.types';
import { StoreRecord, StoreSyncJob } from './store.entities';
import {
  StoreIntegration,
  StoreReviewWorkflow,
} from './store-operations.entities';
import { STORE_CADENCES } from './store-operations.service';
import { StoreAccess } from './store.permissions';

@Injectable()
export class StoreWorker implements OnModuleDestroy {
  private readonly logger = new Logger(StoreWorker.name);
  private stopping = false;
  private active = new Map<AbortController, Promise<void>>();
  constructor(
    private readonly config: StoreConfig,
    private readonly repository: StoreRepository,
    private readonly google: GooglePlayProvider,
    private readonly apple: AppleStoreProvider,
    private readonly access: StoreAccess,
  ) {}

  @Cron('0 * * * * *', { timeZone: 'UTC', waitForCompletion: true })
  async schedule() {
    if (!this.config.scheduled || this.stopping) return;
    const to = day();
    const from = day(new Date(Date.now() - 29 * 86400000));
    for (const platform of STORE_PLATFORMS) {
      if (this.config.missing(platform).length) continue;
      let integration: StoreIntegration | null;
      try {
        integration = await this.repository.db
          .getRepository(StoreIntegration)
          .findOneBy({ platform });
      } catch {
        this.logger.warn(`Store scheduling unavailable: platform=${platform}`);
        continue;
      }
      if (!integration?.enabled) continue;
      for (const task of STORE_TASKS) {
        try {
          const appId = this.config.assertReady(platform);
          const minutes = integration.schedule[task] ?? STORE_CADENCES[task];
          await this.repository.enqueue({
            platform,
            appId,
            task,
            lane: task,
            input: { from, to },
            actorId: null,
            requestKey: `scheduled:${platform}:${appId}:${task}:${minutes}:${Math.floor(Date.now() / (minutes * 60000))}`,
          });
        } catch (error) {
          if (!(error instanceof ConflictException))
            this.logger.warn(
              `Store scheduling failed: platform=${platform}, task=${task}`,
            );
        }
      }
    }
  }

  @Cron('*/30 * * * * *', { waitForCompletion: true })
  async tick() {
    if (!this.config.enabled || this.stopping) return;
    // Separate promises: a Google failure must not prevent Apple work or vice versa.
    await Promise.all(
      STORE_PLATFORMS.map(async (platform) => {
        try {
          if (this.config.missing(platform).length) return;
          if (
            !(
              await this.repository.db
                .getRepository(StoreIntegration)
                .findOneBy({ platform })
            )?.enabled
          )
            return;
          const job = await this.repository.claim(
            platform,
            this.config.assertReady(platform),
          );
          if (!job || this.stopping) return;
          const controller = new AbortController();
          const work = this.run(job, controller);
          this.active.set(controller, work);
          try {
            await work;
          } finally {
            this.active.delete(controller);
          }
        } catch {
          this.logger.warn(`Store worker unavailable: platform=${platform}`);
        }
      }),
    );
  }

  private async run(job: StoreSyncJob, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(), 120000);
    let error: StoreProviderError | undefined;
    let externalWriteStarted = false;
    try {
      const signal = controller.signal;
      if (job.task === 'reply') {
        const [actor] = await this.repository.db.query(
          'SELECT id,role FROM users WHERE id=$1 AND "isActive"',
          [job.actorId],
        );
        if (
          !actor ||
          !(await this.access.permissions(actor.id, actor.role)).includes(
            'store.reviews.reply',
          )
        )
          throw new StoreProviderError('REPLY_PERMISSION_REVOKED');
        const workflow = await this.repository.db
          .getRepository(StoreReviewWorkflow)
          .findOneBy({ recordId: job.input.recordId, publishedJobId: job.id });
        if (
          !workflow ||
          workflow.approvedRevision !== job.input.revision ||
          workflow.revision !== job.input.revision ||
          workflow.draft !== job.input.reply ||
          !workflow.approvedBy
        )
          throw new StoreProviderError('REPLY_APPROVAL_INVALID');
        const record = await this.repository.db
          .getRepository(StoreRecord)
          .findOneBy({
            id: job.input.recordId,
            platform: job.platform,
            appId: job.appId,
            kind: 'review',
          });
        if (!record || !job.input.reply)
          throw new StoreProviderError('REVIEW_NOT_FOUND');
        externalWriteStarted = true;
        const result =
          job.platform === 'google'
            ? await this.google.reply(
                job.appId,
                record.externalId,
                job.input.reply,
                signal,
              )
            : await this.apple.reply(
                record.externalId,
                job.input.reply,
                signal,
              );
        await this.repository.apply(job, {
          items: [
            {
              kind: 'review',
              externalId: record.externalId,
              content: { ...record.content, ...result },
            },
          ],
        });
      } else if (job.task === 'analytics_request') {
        const [actor] = await this.repository.db.query(
          'SELECT id,role FROM users WHERE id=$1 AND "isActive"',
          [job.actorId],
        );
        if (
          !actor ||
          !(await this.access.permissions(actor.id, actor.role)).includes(
            'store.integrations.manage',
          )
        )
          throw new StoreProviderError('INTEGRATION_PERMISSION_REVOKED');
        externalWriteStarted = true;
        await this.apple.requestAnalytics(job.appId, signal);
      } else {
        const known =
          job.platform === 'apple'
            ? await this.repository.db
                .getRepository(StoreRecord)
                .createQueryBuilder('record')
                .select('record.externalId')
                .where(
                  'record.platform = :platform AND record.appId = :appId AND record.kind = :kind',
                  {
                    platform: job.platform,
                    appId: job.appId,
                    kind: 'report',
                  },
                )
                .andWhere("record.externalId LIKE 'instance:%'")
                .orderBy('record.syncedAt', 'DESC')
                .take(10000)
                .getMany()
            : [];
        const batches =
          job.platform === 'google'
            ? this.google.sync(
                job.appId,
                job.task as StoreTask,
                job.input,
                signal,
              )
            : this.apple.sync(
                job.appId,
                job.task as StoreTask,
                job.input,
                signal,
                new Set(known.map((r) => r.externalId)),
              );
        for await (const batch of batches) {
          if (signal.aborted)
            throw new StoreProviderError('SYNC_DEADLINE_EXCEEDED', true);
          await this.repository.apply(job, batch);
          if (
            batch.integrationCheck &&
            Object.values(batch.integrationCheck).some(
              (check) => !check.available,
            )
          )
            throw new StoreProviderError('CONNECTION_CAPABILITY_FAILED');
        }
      }
    } catch (failure) {
      error =
        failure instanceof StoreProviderError
          ? failure
          : new StoreProviderError(
              'SYNC_PROCESSING_FAILED',
              !externalWriteStarted,
              0,
              externalWriteStarted,
            );
      // Mutating tasks are never automatically retried, even when an auth/read step failed.
      if (
        externalWriteStarted &&
        (error.retryable ||
          ['INVALID_PROVIDER_RESPONSE', 'WORKER_LEASE_LOST'].includes(
            error.code,
          ))
      )
        error = new StoreProviderError(error.code, false, 0, true);
      this.logger.warn(
        `Store task ended: job=${job.id}, platform=${job.platform}, code=${error.code}`,
      );
    } finally {
      clearTimeout(timer);
    }
    await this.repository.finish(job, error);
  }

  async onModuleDestroy() {
    this.stopping = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}
