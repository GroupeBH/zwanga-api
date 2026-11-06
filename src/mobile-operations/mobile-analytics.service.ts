import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CacheService } from '../common/services/cache.service';
import { StoreService } from '../store-management/store.service';
import { StoreConfig } from '../store-management/store.config';
import { MobileConfig } from './mobile.config';
import { MobilePageDto } from './mobile.dto';
import { nativeBuild } from './mobile-policy';

type Counts<K extends string> = Record<K, number>;
type InstallationCohort = Counts<
  | 'installations'
  | 'anonymous'
  | 'linked'
  | 'reachable'
  | 'activeLast30Days'
  | 'firstLinksInPeriod'
>;
type Adoption = {
  platform: string;
  version: string;
  build: string;
} & Counts<'installations'>;
type DailyActivity = {
  day: string | Date;
  platform: string;
} & Counts<'installations'>;
type AuditRow = {
  id: string;
  actorId: string | null;
  action: string;
  subjectId: string;
  details: unknown;
  createdAt: Date;
};

export function mobileRange(q: MobilePageDto) {
  const to = q.to ?? new Date().toISOString().slice(0, 10);
  const from =
    q.from ??
    new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
  const span = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(span) || span < 0 || span > 365 * 86400000)
    throw new BadRequestException('Période maximale : 366 jours.');
  return { from, to };
}
@Injectable()
export class MobileAnalyticsService {
  constructor(
    private readonly db: DataSource,
    private readonly config: MobileConfig,
    private readonly cache: CacheService,
    private readonly stores: StoreService,
    private readonly storeConfig: StoreConfig,
  ) {}
  async overview(q: MobilePageDto) {
    this.config.assertEnabled();
    const range = mobileRange(q),
      version = q.version ? nativeBuild(q.version) : null;
    const key = `mobile:analytics:v1:${range.from}:${range.to}:${q.platform ?? ''}:${version ?? ''}`;
    const cached =
      await this.cache.get<
        Awaited<ReturnType<MobileAnalyticsService['loadOverview']>>
      >(key);
    if (cached) return cached;
    const result = await this.loadOverview(q, range, version);
    await this.cache.set(key, result, 60);
    return result;
  }
  private async loadOverview(
    q: MobilePageDto,
    range: ReturnType<typeof mobileRange>,
    version: string | null,
  ) {
    const observedAt = new Date().toISOString();
    const local = await this.db.transaction(async (m) => {
      await m.query(`SET LOCAL statement_timeout='5s'`);
      const scope = `NOT (c."mobileMetadata" ? 'deletedAt') AND ($3::text IS NULL OR c.platform=$3) AND ($4::text IS NULL OR c.version=$4)`;
      const values = [range.from, range.to, q.platform ?? null, version];
      const [cohort] = await m.query<InstallationCohort[]>(
        `SELECT count(*)::int AS installations,
        count(*) FILTER (WHERE c."userId" IS NULL)::int AS anonymous,
        count(*) FILTER (WHERE c."userId" IS NOT NULL)::int AS linked,
        count(*) FILTER (WHERE c.enabled AND c."pushToken" IS NOT NULL)::int AS reachable,
        count(*) FILTER (WHERE c."updatedAt">now()-interval '30 days')::int AS "activeLast30Days",
        count(*) FILTER (WHERE c."firstLinkedAt">=$1::date AND c."firstLinkedAt"<$2::date+interval '1 day')::int AS "firstLinksInPeriod"
        FROM app_update_installations c WHERE ${scope} AND c."createdAt">=$1::date AND c."createdAt"<$2::date+interval '1 day'`,
        values,
      );
      const adoption = await m.query<Adoption[]>(
        `SELECT c.platform,c.version,c.build,count(*)::int AS installations
        FROM app_update_installations c WHERE ${scope} AND c."updatedAt">=$1::date AND c."updatedAt"<$2::date+interval '1 day'
        GROUP BY c.platform,c.version,c.build ORDER BY installations DESC LIMIT 100`,
        values,
      );
      const daily = await m.query<DailyActivity[]>(
        `SELECT d.day,d.platform,count(*)::int AS installations FROM mobile_installation_days d
        WHERE d.day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR d.platform=$3) AND ($4::text IS NULL OR d.version=$4)
        GROUP BY d.day,d.platform ORDER BY d.day`,
        values,
      );
      const retention = await m.query<
        Counts<'days' | 'eligible' | 'retained'>[]
      >(
        `SELECT n.days,
        count(*)::int AS eligible,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM mobile_installation_days d WHERE d."installationId"=c.id
          AND d.day=(c."createdAt" AT TIME ZONE 'UTC')::date+n.days))::int AS retained
        FROM app_update_installations c CROSS JOIN (VALUES (1),(7),(30)) n(days)
        WHERE ${scope} AND c."createdAt">=$1::date AND c."createdAt"<$2::date+interval '1 day'
          AND (c."createdAt" AT TIME ZONE 'UTC')::date+n.days < (now() AT TIME ZONE 'UTC')::date
        GROUP BY n.days ORDER BY n.days`,
        values,
      );
      const [accounts] = await m.query<
        Counts<'registrations' | 'firstTripCompletedAsOfNow'>[]
      >(
        `SELECT count(*)::int AS registrations,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bookings b WHERE b."passengerId"=u.id AND b.status='completed')
          OR EXISTS (SELECT 1 FROM trips t WHERE t."driverId"=u.id AND t.status='completed'))::int AS "firstTripCompletedAsOfNow"
        FROM users u WHERE u."createdAt">=$1::date AND u."createdAt"<$2::date+interval '1 day' AND u.role IN ('driver','passenger')`,
        [range.from, range.to],
      );
      const [activity] = await m.query<
        Counts<'activeDrivers' | 'activePassengers'>[]
      >(
        `SELECT
        (SELECT count(DISTINCT "driverId")::int FROM trips WHERE status='completed' AND "completedAt">=$1::date AND "completedAt"<$2::date+interval '1 day') AS "activeDrivers",
        (SELECT count(DISTINCT b."passengerId")::int FROM bookings b JOIN trips t ON t.id=b."tripId" WHERE b.status='completed'
          AND t."completedAt">=$1::date AND t."completedAt"<$2::date+interval '1 day') AS "activePassengers"`,
        [range.from, range.to],
      );
      const campaignActivity = await m.query<
        ({ state: string } & Counts<'campaigns'>)[]
      >(
        `SELECT m.state,count(*)::int AS campaigns FROM mobile_campaigns m
        WHERE m."createdAt">=$1::date AND m."createdAt"<$2::date+interval '1 day' GROUP BY m.state`,
        [range.from, range.to],
      );
      const [obsolete] = await m.query<Counts<'installations'>[]>(
        `SELECT count(*)::int AS installations FROM app_update_installations c
        WHERE ${scope} AND c."updatedAt">=$1::date AND c."updatedAt"<$2::date+interval '1 day'
        AND EXISTS (SELECT 1 FROM mobile_update_policies p JOIN app_store_releases r ON r.id=p."releaseId"
          WHERE p.active AND p.mode='REQUIRED' AND p."availabilityConfirmed" AND r.available AND p.platform=c.platform
          AND p.environment=c."mobileMetadata"->>'environment' AND p."effectiveAt"<=now() AND (p."expiresAt" IS NULL OR p."expiresAt">now())
          AND (p.audience='all' OR (p.audience='linked' AND c."userId" IS NOT NULL) OR (p.audience='anonymous' AND c."userId" IS NULL))
          AND string_to_array(c.build,'.')::int[]<string_to_array(p."minimumBuild",'.')::int[])`,
        values,
      );
      return {
        cohort,
        adoption,
        daily,
        retention,
        accounts,
        activity,
        campaignActivity,
        obsolete,
      };
    });
    let storeData: unknown = { availability: 'disabled' };
    if (this.storeConfig.enabled) {
      try {
        storeData = await this.stores.dashboard({
          ...range,
          platform:
            q.platform === 'android'
              ? 'google'
              : q.platform === 'ios'
                ? 'apple'
                : undefined,
          version: q.version,
        });
      } catch {
        storeData = { availability: 'temporarily_unavailable', value: null };
      }
    }
    const metric = <T>(
      value: T,
      definition: string,
      unit: string,
      source = 'Zwanga PostgreSQL',
    ) => ({
      value,
      definition,
      unit,
      source,
      period: range,
      synchronizedAt: observedAt,
      availability: 'available',
      completeness: 'observed_retained_data_only',
      timezone: 'UTC',
    });
    const result = {
      generatedAt: observedAt,
      ...range,
      installations: metric(
        local.cohort,
        'current_state_of_retained_installations_first_seen_in_period',
        'installations_not_people',
      ),
      adoption: metric(
        local.adoption,
        'latest_build_of_installations_last_seen_in_period_top_100',
        'installations',
      ),
      activity: metric(
        local.daily,
        'distinct_instrumented_installations_per_day',
        'installations_per_day',
      ),
      retention: metric(
        local.retention,
        'exact_day_return_after_first_contact_mature_cohorts_only',
        'installations',
      ),
      obsoleteBuilds: metric(
        local.obsolete.installations,
        'last_seen_in_period_below_an_active_declared_minimum_build',
        'installations',
      ),
      campaigns: metric(
        local.campaignActivity,
        'campaigns_created_in_period_current_state',
        'campaigns',
      ),
      accounts: metric(
        { ...local.accounts, ...local.activity },
        'registration_cohort_current_outcome; active roles completed a trip in period; all platforms',
        'accounts',
      ),
      conversions: {
        installationToAccountLinkPercent: local.cohort.installations
          ? (100 * local.cohort.firstLinksInPeriod) / local.cohort.installations
          : null,
        accountToFirstTripPercent: local.accounts.registrations
          ? (100 * local.accounts.firstTripCompletedAsOfNow) /
            local.accounts.registrations
          : null,
        installationToNewSignupPercent: null,
        definition:
          'linking may refer to an existing account; no store or campaign attribution',
      },
      stores: storeData,
      filters: {
        installation: q.platform ?? 'all',
        version: q.version ?? 'all',
        business: 'date_only_no_device_attribution',
      },
      unavailable: {
        countryOfInstallation: 'not_collected',
        crashlytics: 'not_configured',
        providerAcceptanceIsDeviceDelivery: false,
      },
    };
    return result;
  }
  async audit(q: MobilePageDto) {
    this.config.assertEnabled();
    const items = await this.db.query<AuditRow[]>(
      `SELECT id,"actorId",action,"subjectId",details,"createdAt" FROM store_audit_logs
      WHERE action LIKE 'mobile.%' ORDER BY "createdAt" DESC,id LIMIT $1 OFFSET $2`,
      [q.limit, (q.page - 1) * q.limit],
    );
    return { items, page: q.page, limit: q.limit };
  }
}
