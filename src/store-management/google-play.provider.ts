import { Injectable } from '@nestjs/common';
import { StoreAuth } from './store.auth';
import { StoreConfig } from './store.config';
import { decodeReport, StoreHttp } from './store.http';
import { normalizeReport, parseReport } from './store.reports';
import {
  day,
  identifier,
  list,
  object,
  StoreBatch,
  StoreProviderError,
  StoreRange,
  StoreTask,
  textValue,
} from './store.types';

@Injectable()
export class GooglePlayProvider {
  constructor(
    private readonly auth: StoreAuth,
    private readonly http: StoreHttp,
    private readonly config: StoreConfig,
  ) {}
  private base(app: string) {
    return `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${identifier(app)}`;
  }

  async *sync(
    app: string,
    task: StoreTask,
    range: StoreRange,
    signal: AbortSignal,
  ): AsyncGenerator<StoreBatch> {
    if (task === 'connection') {
      yield { integrationCheck: await this.connection(app, signal) };
      return;
    }
    if (task === 'reports') {
      yield* this.reports(app, range, signal);
      return;
    }
    if (task === 'vitals') {
      yield* this.vitals(app, range, signal);
      yield* this.issues(app, signal);
      return;
    }
    const token = await this.auth.google('publisher');
    if (task === 'catalog') {
      // A dedicated service account is required. This temporary edit is NEVER committed.
      const edit = object(
        await this.http.api(`${this.base(app)}/edits`, token, {
          method: 'POST',
          data: {},
          signal,
        }),
      );
      const id = textValue(edit.id, 256);
      if (!id) throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
      try {
        const [details, tracks] = await Promise.all([
          this.http.api(
            `${this.base(app)}/edits/${identifier(id)}/details`,
            token,
            { signal },
          ),
          this.http.api(
            `${this.base(app)}/edits/${identifier(id)}/tracks`,
            token,
            { signal },
          ),
        ]);
        yield {
          replaceKinds: ['app', 'release'],
          items: [
            {
              kind: 'app',
              externalId: app,
              content: {
                packageName: app,
                defaultLanguage: object(details).defaultLanguage ?? null,
              },
            },
            ...list(object(tracks).tracks ?? []).map((track) => ({
              kind: 'release' as const,
              externalId: textValue(track.track, 256),
              content: {
                track: textValue(track.track, 256),
                releases: list(track.releases ?? []).map((r) => ({
                  name: textValue(r.name, 256),
                  status: textValue(r.status, 100),
                  versionCodes: list(r.versionCodes ?? []).map((v) =>
                    textValue(v, 30),
                  ),
                  userFraction:
                    typeof r.userFraction === 'number' ? r.userFraction : null,
                  releaseNotes: list(r.releaseNotes ?? []).map((n) => ({
                    language: textValue(n.language, 32),
                    text: textValue(n.text),
                  })),
                })),
              },
            })),
          ],
        };
      } finally {
        // Use a separate short deadline even when the job deadline was exceeded.
        try {
          await this.http.api(
            `${this.base(app)}/edits/${identifier(id)}`,
            token,
            { method: 'DELETE', signal: AbortSignal.timeout(10000) },
          );
        } catch {
          throw new StoreProviderError('GOOGLE_TEMPORARY_EDIT_CLEANUP_FAILED');
        }
      }
      return;
    }
    let pageToken: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const response = object(
        await this.http.api(`${this.base(app)}/reviews`, token, {
          params: { maxResults: 100, token: pageToken },
          signal,
        }),
      );
      yield {
        items: list(response.reviews ?? []).map((review) => {
          const comments = list(review.comments ?? []);
          const user = object(
            comments.find((c) => c.userComment)?.userComment ?? {},
          );
          const developer = comments.find(
            (c) => c.developerComment,
          )?.developerComment;
          const rating = Number(user.starRating);
          if (!Number.isInteger(rating) || rating < 1 || rating > 5)
            throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
          return {
            kind: 'review',
            externalId: textValue(review.reviewId, 512),
            content: {
              text: textValue(user.text),
              author: textValue(review.authorName, 500),
              rating,
              language: textValue(user.reviewerLanguage, 32),
              version: textValue(user.appVersionName, 100),
              modifiedAt: user.lastModified?.seconds
                ? new Date(
                    Number(user.lastModified.seconds) * 1000,
                  ).toISOString()
                : null,
              response: developer ? textValue(developer.text) : null,
              responseId: developer ? textValue(review.reviewId, 512) : null,
              responseState: developer ? 'published' : null,
              coverage: 'recent_modified_reviews_with_comments_only',
            },
          };
        }),
      };
      pageToken = response.tokenPagination?.nextPageToken;
      if (!pageToken) return;
      if (seen.has(pageToken))
        throw new StoreProviderError('PROVIDER_PAGINATION_LOOP');
      seen.add(pageToken);
    }
    throw new StoreProviderError('PROVIDER_PAGE_LIMIT_REACHED');
  }

  private async connection(app: string, signal: AbortSignal) {
    const checks: Record<string, { available: boolean; errorCode?: string }> =
      {};
    const probe = async (name: string, operation: () => Promise<unknown>) => {
      try {
        await operation();
        checks[name] = { available: true };
      } catch (e) {
        checks[name] = {
          available: false,
          errorCode:
            e instanceof StoreProviderError ? e.code : 'CONNECTION_FAILED',
        };
      }
    };
    await probe('publisher_reviews_read', async () =>
      this.http.api(
        `${this.base(app)}/reviews`,
        await this.auth.google('publisher'),
        { params: { maxResults: 1 }, signal },
      ),
    );
    await probe('android_vitals_read', async () =>
      this.http.api(
        `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${identifier(app)}/crashRateMetricSet`,
        await this.auth.google('reporting'),
        { signal },
      ),
    );
    await probe('statistics_read', async () => {
      const bucket = this.config.value('STORE_GOOGLE_REPORTS_BUCKET');
      if (!/^pubsite_prod_[a-zA-Z0-9_-]+$/.test(bucket))
        throw new StoreProviderError('GOOGLE_REPORTS_BUCKET_NOT_CONFIGURED');
      return this.http.api(
        `https://storage.googleapis.com/storage/v1/b/${identifier(bucket)}/o`,
        await this.auth.google('storage'),
        {
          params: { maxResults: 1, prefix: `stats/installs/installs_${app}_` },
          signal,
        },
      );
    });
    return checks;
  }

  async reply(app: string, review: string, text: string, signal: AbortSignal) {
    if ([...text].length > 350)
      throw new StoreProviderError('GOOGLE_REPLY_TOO_LONG');
    const response = await this.http.api(
      `${this.base(app)}/reviews/${identifier(review)}:reply`,
      await this.auth.google('publisher'),
      { method: 'POST', data: { replyText: text }, signal },
    );
    return {
      response: textValue(object(response).result?.replyText),
      responseState: 'submitted',
      responseId: review,
    };
  }

  private async *reports(
    app: string,
    range: StoreRange,
    signal: AbortSignal,
  ): AsyncGenerator<StoreBatch> {
    const bucket = this.config.value('STORE_GOOGLE_REPORTS_BUCKET');
    if (!/^pubsite_prod_[a-zA-Z0-9_-]+$/.test(bucket))
      throw new StoreProviderError('GOOGLE_REPORTS_BUCKET_NOT_CONFIGURED');
    const token = await this.auth.google('storage');
    let imported = 0;
    const date = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`);
    while (day(date) <= range.to) {
      const month = day(date).slice(0, 7).replace('-', '');
      const requested = (
        this.config.value('STORE_GOOGLE_INSTALL_DIMENSIONS') ||
        'country,app_version,device,os_version'
      ).split(',');
      const dimensions = [
        ...new Set([
          'country',
          ...requested.filter((d) =>
            ['country', 'app_version', 'device', 'os_version'].includes(d),
          ),
        ]),
      ];
      const files = [
        ...dimensions.map((d) => ({ type: 'installs', dimension: d })),
        { type: 'store_performance', dimension: 'country' },
        { type: 'crashes', dimension: 'app_version' },
      ];
      for (const { type, dimension } of files) {
        const path = `stats/${type}/${type}_${app}_${month}_${dimension}.csv`;
        const url = `https://storage.googleapis.com/storage/v1/b/${identifier(bucket)}/o/${identifier(path)}?alt=media`;
        try {
          const bytes = Buffer.from(
            await this.http.api<ArrayBuffer>(url, token, {
              responseType: 'arraybuffer',
              signal,
            }),
          );
          const partitions = normalizeReport(
            parseReport(await decodeReport(bytes), ','),
            {
              appId: app,
              dataset: dimension === 'country' ? type : `${type}_${dimension}`,
              revision: new Date().toISOString(),
              range,
              format:
                type === 'installs'
                  ? 'google_installs'
                  : type === 'crashes'
                    ? 'google_crashes'
                    : 'google_acquisitions',
            },
          );
          yield {
            partitions,
            items: [
              {
                kind: 'report',
                externalId: path,
                content: {
                  type,
                  month,
                  state: 'available',
                  days: partitions.length,
                },
              },
            ],
          };
          imported++;
        } catch (error) {
          if (
            !(error instanceof StoreProviderError) ||
            error.code !== 'PROVIDER_DATA_UNAVAILABLE'
          )
            throw error;
          yield {
            items: [
              {
                kind: 'report',
                externalId: path,
                content: {
                  type,
                  month,
                  state: 'unavailable',
                  reason: error.code,
                },
              },
            ],
          };
        }
      }
      date.setUTCMonth(date.getUTCMonth() + 1);
    }
    if (!imported) throw new StoreProviderError('REPORTS_NOT_YET_AVAILABLE');
  }

  private async *vitals(
    app: string,
    range: StoreRange,
    signal: AbortSignal,
  ): AsyncGenerator<StoreBatch> {
    const token = await this.auth.google('reporting');
    const asDate = (s: string) => ({
      year: Number(s.slice(0, 4)),
      month: Number(s.slice(5, 7)),
      day: Number(s.slice(8, 10)),
      timeZone: { id: 'America/Los_Angeles' },
    });
    for (const [set, names] of [
      ['crashRateMetricSet', ['crashRate', 'userPerceivedCrashRate']],
      ['anrRateMetricSet', ['anrRate', 'userPerceivedAnrRate']],
    ] as const) {
      const url = `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${identifier(app)}/${set}`;
      const info = object(await this.http.api(url, token, { signal }));
      const fresh = list(info.freshnessInfo?.freshnesses ?? []).find(
        (f) => f.aggregationPeriod === 'DAILY',
      )?.latestEndTime;
      if (!fresh) throw new StoreProviderError('VITALS_NOT_YET_AVAILABLE');
      const latest = `${fresh.year}-${String(fresh.month).padStart(2, '0')}-${String(fresh.day).padStart(2, '0')}`;
      const requestedEnd = day(new Date(Date.parse(range.to) + 86400000));
      const end = latest < requestedEnd ? latest : requestedEnd;
      if (end <= range.from)
        throw new StoreProviderError('VITALS_NOT_YET_AVAILABLE');
      const response = object(
        await this.http.api(`${url}:query`, token, {
          method: 'POST',
          signal,
          data: {
            timelineSpec: {
              aggregationPeriod: 'DAILY',
              startTime: asDate(range.from),
              endTime: asDate(end),
            },
            metrics: names,
            pageSize: 1000,
          },
        }),
      );
      if (response.nextPageToken)
        throw new StoreProviderError('PROVIDER_PAGE_LIMIT_REACHED');
      const partitions = list(response.rows ?? []).map((row) => {
        const date = `${row.startTime.year}-${String(row.startTime.month).padStart(2, '0')}-${String(row.startTime.day).padStart(2, '0')}`;
        return {
          dataset: set,
          date,
          revision: new Date().toISOString(),
          points: list(row.metrics).map((m) => {
            const rawValue = m.decimalValue?.value;
            if (
              rawValue === null ||
              rawValue === undefined ||
              rawValue === '' ||
              !['number', 'string'].includes(typeof rawValue)
            )
              throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
            const value = Number(rawValue);
            if (
              !Number.isFinite(value) ||
              value < 0 ||
              !(names as readonly string[]).includes(m.metric)
            )
              throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
            return {
              date,
              dimension: '{}',
              metric: `google.${m.metric}`,
              value,
            };
          }),
        };
      });
      yield {
        partitions,
        items: [
          {
            kind: 'performance',
            externalId: set,
            content: {
              latestEndDate: latest,
              timezone: 'America/Los_Angeles',
              state: partitions.length ? 'available' : 'unavailable',
            },
          },
        ],
      };
    }
  }
  private async *issues(
    app: string,
    signal: AbortSignal,
  ): AsyncGenerator<StoreBatch> {
    const token = await this.auth.google('reporting');
    let pageToken: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = object(
        await this.http.api(
          `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${identifier(app)}/errorIssues:search`,
          token,
          {
            signal,
            params: { pageSize: 100, pageToken, sampleErrorReportLimit: 0 },
          },
        ),
      );
      yield {
        items: list(result.errorIssues ?? []).map((issue) => ({
          kind: 'performance' as const,
          externalId: textValue(issue.name, 1000),
          content: {
            category: 'error_issue',
            type: textValue(issue.type, 100),
            cause: textValue(issue.cause),
            location: textValue(issue.location),
            errorReportCount: textValue(issue.errorReportCount, 30),
            lastErrorReportTime: textValue(issue.lastErrorReportTime, 100),
            issueUri: textValue(issue.issueUri, 2000),
            firstAppVersion: issue.firstAppVersion ?? null,
            lastAppVersion: issue.lastAppVersion ?? null,
            source: 'Google Play Developer Reporting API / ErrorIssues',
            period: 'provider_default_last_24_hours',
          },
        })),
      };
      pageToken = result.nextPageToken;
      if (!pageToken) return;
      if (seen.has(pageToken))
        throw new StoreProviderError('PROVIDER_PAGINATION_LOOP');
      seen.add(pageToken);
    }
    throw new StoreProviderError('PROVIDER_PAGE_LIMIT_REACHED');
  }
}
