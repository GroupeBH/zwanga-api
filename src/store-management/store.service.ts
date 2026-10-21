import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Brackets } from 'typeorm';
import { CacheService } from '../common/services/cache.service';
import { StoreConfig } from './store.config';
import { StoreRepository } from './store.repository';
import { StoreMetric, StoreRecord, StoreSyncJob } from './store.entities';
import {
  StoreMetricsDto,
  StorePageDto,
  StoreRangeDto,
  StoreRecordsDto,
  StoreSyncDto,
  storeRange,
} from './store.dto';
import { STORE_PLATFORMS, StoreJobTask, StorePlatform } from './store.types';
import { storePermissions } from './store.permissions';
import { METRIC_CATALOG } from './store.reports';
import {
  StoreIntegration,
  StoreReviewWorkflow,
} from './store-operations.entities';

@Injectable()
export class StoreService {
  constructor(
    private readonly config: StoreConfig,
    private readonly repository: StoreRepository,
    private readonly cache: CacheService,
  ) {}
  status(
    role: unknown,
    permissions: readonly string[] = storePermissions(role),
  ) {
    return {
      enabled: this.config.enabled,
      scheduled: this.config.scheduled,
      permissions,
      platforms: STORE_PLATFORMS.map((platform) => ({
        platform,
        appId: this.config.appId(platform) || null,
        configured: this.config.missing(platform).length === 0,
        missingVariables: this.config.missing(platform),
      })),
    };
  }
  private scope(alias: string, platform?: StorePlatform) {
    return new Brackets((q) => {
      for (const p of platform ? [platform] : STORE_PLATFORMS)
        q.orWhere(`${alias}.platform = :${p} AND ${alias}.appId = :${p}App`, {
          [p]: p,
          [`${p}App`]: this.config.appId(p),
        });
    });
  }
  async records(query: StoreRecordsDto) {
    this.config.assertEnabled();
    const qb = this.repository.db
      .getRepository(StoreRecord)
      .createQueryBuilder('record')
      .where(this.scope('record', query.platform));
    if (query.kind) qb.andWhere('record.kind = :kind', { kind: query.kind });
    if (query.category)
      qb.andWhere("record.content->>'category'=:category", {
        category: query.category,
      });
    // Partition markers are internal import checkpoints, not downloadable reports.
    qb.andWhere("record.externalId NOT LIKE 'partition:%'");
    if (query.rating)
      qb.andWhere(
        "record.kind='review' AND record.content->>'rating' = :rating",
        { rating: String(query.rating) },
      );
    if (query.search)
      qb.andWhere(
        "(record.content->>'text' ILIKE :search OR record.content->>'title' ILIKE :search)",
        { search: `%${query.search.replace(/[\\%_]/g, '\\$&')}%` },
      );
    if (query.country)
      qb.andWhere(
        "COALESCE(record.content->>'territory',record.content->>'country')=:country",
        { country: query.country },
      );
    if (query.version)
      qb.andWhere(
        "COALESCE(record.content->>'version',record.content->>'versionString')=:version",
        { version: query.version },
      );
    if (query.responded)
      qb.andWhere(
        `NULLIF(record.content->>'response','') IS ${query.responded === 'yes' ? 'NOT ' : ''}NULL`,
      );
    if (query.status)
      qb.leftJoin(
        StoreReviewWorkflow,
        'workflow',
        'workflow.recordId=record.id',
      ).andWhere("COALESCE(workflow.status,'new')=:status", {
        status: query.status,
      });
    if (query.from || query.to) {
      const range = storeRange(query, 366);
      qb.andWhere(
        "substring(record.content->>'modifiedAt',1,10) BETWEEN :from AND :to",
        range,
      );
    }
    const [items, total] = await qb
      .orderBy('record.syncedAt', 'DESC')
      .addOrderBy('record.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return { items, total, page: query.page, limit: query.limit };
  }
  async history(query: StorePageDto) {
    this.config.assertEnabled();
    const [items, total] = await this.repository.db
      .getRepository(StoreSyncJob)
      .createQueryBuilder('job')
      .where(this.scope('job', query.platform))
      .orderBy('job.createdAt', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return { items, total, page: query.page, limit: query.limit };
  }
  async job(id: string) {
    this.config.assertEnabled();
    const row = await this.repository.db
      .getRepository(StoreSyncJob)
      .createQueryBuilder('j')
      .where('j.id=:id', { id })
      .andWhere(this.scope('j'))
      .getOne();
    if (!row) throw new NotFoundException('Synchronisation introuvable.');
    return row;
  }
  async sync(actorId: string, platform: StorePlatform, dto: StoreSyncDto) {
    if (
      dto.country ||
      dto.version ||
      (dto.platform && dto.platform !== platform)
    )
      throw new BadRequestException(
        'Les imports concernent toutes les dimensions de la plateforme choisie.',
      );
    const range = storeRange(dto);
    return this.enqueue(actorId, platform, dto.task, dto.requestId, range);
  }
  private async enqueue(
    actorId: string,
    platform: StorePlatform,
    task: StoreJobTask,
    requestId: string,
    input: StoreSyncJob['input'],
  ) {
    const appId = this.config.assertReady(platform);
    if (
      !(
        await this.repository.db
          .getRepository(StoreIntegration)
          .findOneBy({ platform })
      )?.enabled
    )
      throw new BadRequestException('Intégration désactivée.');
    return this.repository.enqueue({
      platform,
      appId,
      task,
      lane:
        task === 'reply'
          ? 'reviews'
          : task === 'analytics_request'
            ? 'reports'
            : task,
      actorId,
      input,
      requestKey: `manual:${actorId}:${requestId}`,
    });
  }
  async retry(actorId: string, id: string, requestId: string) {
    this.config.assertEnabled();
    const job = await this.repository.db
      .getRepository(StoreSyncJob)
      .createQueryBuilder('job')
      .where('job.id = :id', { id })
      .andWhere(this.scope('job'))
      .getOne();
    if (!job) throw new NotFoundException('Synchronisation introuvable.');
    if (job.task === 'reply' || job.task === 'analytics_request')
      throw new BadRequestException(
        'Vérifiez le résultat externe avant de soumettre une nouvelle opération ; aucune relance automatique des écritures.',
      );
    if (!['failed', 'unavailable', 'unknown'].includes(job.state))
      throw new BadRequestException(
        'Cette synchronisation ne nécessite pas de relance.',
      );
    return this.enqueue(actorId, job.platform, job.task, requestId, job.input);
  }
  requestAnalytics(actorId: string, requestId: string) {
    return this.enqueue(actorId, 'apple', 'analytics_request', requestId, {
      from: '1970-01-01',
      to: '1970-01-01',
    });
  }
  metricCatalog() {
    return METRIC_CATALOG;
  }
  async metrics(query: StoreMetricsDto) {
    this.config.assertEnabled();
    const range = storeRange(query, 366);
    const qb = this.repository.db
      .getRepository(StoreMetric)
      .createQueryBuilder('metric')
      .where(this.scope('metric', query.platform))
      .andWhere('metric.date BETWEEN :from AND :to', range);
    if (query.metric)
      qb.andWhere('metric.metric = :metric', { metric: query.metric });
    if (query.country)
      qb.andWhere("metric.dimension::jsonb->>'country'=:country", {
        country: query.country,
      });
    if (query.version)
      qb.andWhere("metric.dimension::jsonb->>'version'=:version", {
        version: query.version,
      });
    const [items, total] = await qb
      .orderBy('metric.date', 'DESC')
      .addOrderBy('metric.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: items.map((item) => ({
        ...item,
        definition: METRIC_CATALOG.find((m) => m.id === item.metric),
        availability: 'available',
      })),
      total,
      ...range,
      page: query.page,
      limit: query.limit,
    };
  }

  async dashboard(query: StoreRangeDto) {
    this.config.assertEnabled();
    const range = storeRange(query);
    const revisions = await this.repository.db
      .getRepository(StoreIntegration)
      .find({
        select: { platform: true, updatedAt: true },
        order: { platform: 'ASC' },
      });
    const generation = revisions.map((r) => r.updatedAt.getTime()).join(':');
    const key = `store:dashboard:v2:${generation}:${this.config.appId('google')}:${this.config.appId('apple')}:${range.from}:${range.to}:${query.platform ?? ''}:${query.country ?? ''}:${query.version ?? ''}`;
    const cached = await this.cache.get<unknown>(key);
    if (cached) return cached;
    const seriesQuery = this.repository.db
      .getRepository(StoreMetric)
      .createQueryBuilder('m')
      .select('m.platform', 'platform')
      .addSelect('m.date', 'date')
      .addSelect('m.metric', 'metric')
      // Daily rates are queried without dimensions; do not aggregate them across days.
      .addSelect('SUM(m.value)::text', 'value')
      .addSelect('MAX(m.importedAt)', 'importedAt')
      .where(this.scope('m', query.platform))
      .andWhere('m.date BETWEEN :from AND :to', range);
    // Alternate Google breakdowns describe the SAME installs. Never add them together.
    seriesQuery.andWhere(
      "(m.platform<>'google' OR m.dataset NOT LIKE 'installs%' OR m.dataset=:installDataset)",
      { installDataset: query.version ? 'installs_app_version' : 'installs' },
    );
    if (query.country)
      seriesQuery.andWhere("m.dimension::jsonb->>'country'=:country", {
        country: query.country,
      });
    if (query.version)
      seriesQuery.andWhere("m.dimension::jsonb->>'version'=:version", {
        version: query.version,
      });
    const series = await seriesQuery
      .groupBy('m.platform')
      .addGroupBy('m.date')
      .addGroupBy('m.metric')
      .orderBy('m.date', 'ASC')
      .getRawMany();
    const cohorts = await this.repository.db.transaction(async (manager) => {
      await manager.query("SET LOCAL statement_timeout = '5s'");
      return manager.query(
        `SELECT u."createdAt"::date::text AS date, count(*)::int AS registrations,
        count(*) FILTER (WHERE u.role='driver')::int AS drivers,
        count(*) FILTER (WHERE u.role='passenger')::int AS passengers,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM kyc_documents k WHERE k."userId"=u.id))::int AS "kycSubmitted",
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM kyc_documents k WHERE k."userId"=u.id AND k.status='approved'))::int AS "kycApproved",
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bookings b WHERE b."passengerId"=u.id AND b.status='completed')
          OR EXISTS (SELECT 1 FROM trips t WHERE t."driverId"=u.id AND t.status='completed'))::int AS "firstTripCompleted"
        FROM users u WHERE u."createdAt">=$1::date AND u."createdAt"<($2::date+interval '1 day')
          AND u.role IN ('passenger','driver') GROUP BY u."createdAt"::date ORDER BY date`,
        [range.from, range.to],
      );
    });
    const reviewStats = await this.repository.db
      .getRepository(StoreRecord)
      .createQueryBuilder('r')
      .select('r.platform', 'platform')
      .addSelect('COUNT(*)::int', 'reviews')
      .addSelect(
        "COUNT(*) FILTER (WHERE NULLIF(r.content->>'response','') IS NULL)::int",
        'unanswered',
      )
      .addSelect(
        "AVG((r.content->>'rating')::numeric)::text",
        'sampleAverageRating',
      )
      .where(this.scope('r', query.platform))
      .andWhere("r.kind='review'")
      .andWhere(
        "substring(r.content->>'modifiedAt',1,10) BETWEEN :from AND :to",
        range,
      )
      .groupBy('r.platform')
      .getRawMany();
    const freshness = await this.repository.db
      .getRepository(StoreSyncJob)
      .createQueryBuilder('j')
      .where(this.scope('j'))
      .distinctOn(['j.platform', 'j.task'])
      .orderBy('j.platform')
      .addOrderBy('j.task')
      .addOrderBy('j.createdAt', 'DESC')
      .getMany();
    const business = await this.repository.db.transaction(async (m) => {
      await m.query("SET LOCAL statement_timeout='5s'");
      const platforms = await m.query(
        `SELECT COALESCE(c.platform,'unknown') AS platform,count(*)::int AS registrations
        FROM users u LEFT JOIN app_update_clients c ON c."userId"=u.id
        WHERE u."createdAt">=$1::date AND u."createdAt"<$2::date+interval '1 day' AND u.role IN ('passenger','driver')
        GROUP BY COALESCE(c.platform,'unknown')`,
        [range.from, range.to],
      );
      const [activity] = await m.query(
        `SELECT
        (SELECT count(*)::int FROM users WHERE role IN ('passenger','driver') AND "lastLoginAt">=$1::date AND "lastLoginAt"<$2::date+interval '1 day') AS "accountsWithLatestLoginInPeriod",
        (SELECT count(*)::int FROM trips WHERE status='completed' AND "completedAt">=$1::date AND "completedAt"<$2::date+interval '1 day') AS "completedTrips"`,
        [range.from, range.to],
      );
      return {
        platforms,
        ...activity,
        platformDefinition:
          'latest_reported_device_of_registration_cohort_not_signup_attribution',
        activeUsersDefinition: 'latest_login_proxy_not_sessions_or_DAU',
      };
    });
    const totals = cohorts.reduce(
      (s: any, c: any) => ({
        registrations: s.registrations + c.registrations,
        submitted: s.submitted + c.kycSubmitted,
        approved: s.approved + c.kycApproved,
        firstTrip: s.firstTrip + c.firstTripCompleted,
      }),
      { registrations: 0, submitted: 0, approved: 0, firstTrip: 0 },
    );
    const result = {
      ...range,
      generatedAt: new Date().toISOString(),
      series,
      cohorts,
      reviewStats,
      freshness: freshness
        .filter((j) => !['reply', 'analytics_request'].includes(j.task))
        .map((j) => ({
          platform: j.platform,
          task: j.task,
          state: j.state,
          completedAt: j.completedAt,
          errorCode: j.errorCode,
        })),
      business,
      conversion: {
        kycApprovalPercent: totals.submitted
          ? (totals.approved / totals.submitted) * 100
          : null,
        firstTripPercent: totals.registrations
          ? (totals.firstTrip / totals.registrations) * 100
          : null,
        downloadToRegistrationPercent: null,
        reason:
          'No comparable cross-store denominator or signup attribution; installations are not registrations.',
      },
      definitions: METRIC_CATALOG,
      cohortFilters:
        'registration_dates_only; store country/version/platform filters do not attribute Zwanga registrations',
      comparison: {
        android: 'google.device_installs',
        ios: 'apple.first_time_downloads',
        directlyComparable: false,
      },
      attribution: 'aggregate_only',
      cohortOutcome: 'current_state_of_users_registered_in_period',
      notes: [
        'Les jours absents sont indisponibles, pas des zéros. Des rapports peuvent être incomplets ou soumis à des seuils de confidentialité.',
        'Google : fuseau du rapport (Vitals America/Los_Angeles). Apple : fuseau du rapport. Cohortes Zwanga : UTC.',
        'Pas de suivi individuel du store vers Zwanga, ni de conversion causale. Les cohortes incluent les comptes passagers/conducteurs encore présents en base.',
        'Les avis importés ne représentent pas toutes les notes sans commentaire. Google ne fournit que les avis récemment modifiés.',
      ],
    };
    await this.cache.set(key, result, 120);
    return result;
  }
  async countries(query: StoreMetricsDto) {
    this.config.assertEnabled();
    const range = storeRange(query);
    const qb = this.repository.db
      .getRepository(StoreMetric)
      .createQueryBuilder('m')
      .where(this.scope('m', query.platform))
      .andWhere('m.date BETWEEN :from AND :to', range)
      .andWhere("m.dimension LIKE '{%'")
      .andWhere(
        "(m.platform<>'google' OR m.dataset IN ('installs','store_performance'))",
      )
      .andWhere(
        "m.metric IN ('google.device_installs','google.store_acquisitions','apple.first_time_downloads','apple.redownloads')",
      )
      .select('m.platform', 'platform')
      .addSelect('m.metric', 'metric')
      .addSelect("m.dimension::jsonb->>'country'", 'country')
      .addSelect('SUM(m.value)::text', 'value')
      .groupBy('m.platform')
      .addGroupBy('m.metric')
      .addGroupBy("m.dimension::jsonb->>'country'");
    if (query.metric) qb.andWhere('m.metric=:metric', { metric: query.metric });
    if (query.country)
      qb.andWhere("m.dimension::jsonb->>'country'=:country", {
        country: query.country,
      });
    if (query.version)
      qb.andWhere("m.dimension::jsonb->>'version'=:version", {
        version: query.version,
      });
    const items = await qb
      .orderBy('m.platform')
      .addOrderBy('m.metric')
      .addOrderBy('country')
      .offset((query.page - 1) * query.limit)
      .limit(query.limit + 1)
      .getRawMany();
    return {
      items: items.slice(0, query.limit),
      hasMore: items.length > query.limit,
      ...range,
      definitions: METRIC_CATALOG,
    };
  }

  async alerts() {
    this.config.assertEnabled();
    const jobs = await this.repository.db
      .getRepository(StoreSyncJob)
      .createQueryBuilder('j')
      .where(this.scope('j'))
      .distinctOn(['j.platform', 'j.task'])
      .orderBy('j.platform')
      .addOrderBy('j.task')
      .addOrderBy('j.createdAt', 'DESC')
      .getMany();
    const alerts = jobs
      .filter((j) => ['failed', 'unavailable', 'unknown'].includes(j.state))
      .map((j) => ({
        id: j.id,
        platform: j.platform,
        code: j.errorCode ?? j.state,
        severity: j.state === 'unavailable' ? 'warning' : 'error',
        task: j.task,
      }));
    const last = await this.repository.db
      .getRepository(StoreSyncJob)
      .createQueryBuilder('j')
      .where(this.scope('j'))
      .andWhere(
        "j.state='succeeded' AND j.task NOT IN ('reply','analytics_request')",
      )
      .select('j.platform', 'platform')
      .addSelect('MAX(j.completedAt)', 'at')
      .groupBy('j.platform')
      .getRawMany();
    for (const platform of STORE_PLATFORMS) {
      const at = last.find((r) => r.platform === platform)?.at;
      if (!at || Date.now() - new Date(at).getTime() > 36 * 3600000)
        alerts.push({
          id: `stale:${platform}`,
          platform,
          code: 'STORE_DATA_STALE_OR_MISSING',
          severity: 'warning',
          task: 'reports',
        });
    }
    return {
      items: alerts,
      delivery: 'admin_dashboard',
      thresholds: 'technical_only',
      generatedAt: new Date().toISOString(),
    };
  }
}
