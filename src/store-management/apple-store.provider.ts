import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  StoreItem,
  StoreProviderError,
  StoreRange,
  StoreTask,
  textValue,
} from './store.types';

const API = 'https://api.appstoreconnect.apple.com/v1';
const fields = (value: any, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, value?.[key] ?? null]));

@Injectable()
export class AppleStoreProvider {
  constructor(
    private readonly auth: StoreAuth,
    private readonly http: StoreHttp,
    private readonly config: StoreConfig,
  ) {}

  async *pages(
    path: string,
    signal: AbortSignal,
    params: Record<string, string | number> = {},
  ): AsyncGenerator<any> {
    let url: string | undefined = `${API}${path}`;
    const expectedPath = new URL(url).pathname;
    const seen = new Set<string>();
    for (let page = 0; page < 20 && url; page++) {
      const parsed = new URL(url);
      if (
        parsed.origin !== 'https://api.appstoreconnect.apple.com' ||
        parsed.pathname !== expectedPath ||
        parsed.username ||
        parsed.password
      )
        throw new StoreProviderError('PROVIDER_PAGINATION_URL_REJECTED');
      if (seen.has(url))
        throw new StoreProviderError('PROVIDER_PAGINATION_LOOP');
      seen.add(url);
      const result = object(
        await this.http.api(url, this.auth.apple(), {
          signal,
          params: page === 0 ? { limit: 200, ...params } : undefined,
        }),
      );
      list(result.data);
      yield result;
      url = result.links?.next || undefined;
    }
    if (url) throw new StoreProviderError('PROVIDER_PAGE_LIMIT_REACHED');
  }

  private async collect(
    path: string,
    signal: AbortSignal,
    params?: Record<string, string | number>,
  ) {
    const data: any[] = [];
    for await (const page of this.pages(path, signal, params))
      data.push(...page.data);
    return data;
  }

  async *sync(
    app: string,
    task: StoreTask,
    range: StoreRange,
    signal: AbortSignal,
    imported: Set<string>,
  ): AsyncGenerator<StoreBatch> {
    if (task === 'connection') {
      const checks: Record<string, { available: boolean; errorCode?: string }> =
        {};
      for (const [name, path] of [
        ['application_read', `/apps/${identifier(app)}`],
        ['reviews_read', `/apps/${identifier(app)}/customerReviews?limit=1`],
        [
          'analytics_read',
          `/apps/${identifier(app)}/analyticsReportRequests?limit=1`,
        ],
        ['builds_read', `/builds?filter[app]=${identifier(app)}&limit=1`],
      ]) {
        try {
          await this.http.api(`${API}${path}`, this.auth.apple(), { signal });
          checks[name] = { available: true };
        } catch (e) {
          checks[name] = {
            available: false,
            errorCode:
              e instanceof StoreProviderError ? e.code : 'CONNECTION_FAILED',
          };
        }
      }
      yield { integrationCheck: checks };
      return;
    }
    if (task === 'vitals') {
      try {
        const metrics = object(
          await this.http.api(
            `${API}/apps/${identifier(app)}/perfPowerMetrics`,
            this.auth.apple(),
            {
              signal,
              headers: {
                Accept:
                  'application/vnd.apple.xcode-metrics+json,application/json',
              },
              params: { 'filter[platform]': 'IOS' },
            },
          ),
        );
        // This API describes percentiles by version, NOT a daily time series.
        const productData = list(metrics.productData ?? []);
        yield {
          items: [
            {
              kind: 'performance',
              externalId: 'apple.power_performance',
              content: {
                source: 'App Store Connect Power and Performance Metrics',
                state: productData.length ? 'available' : 'unavailable',
                productData,
                insights: metrics.insights ?? null,
                aggregation: 'none',
                scope: 'recent_versions',
              },
            },
          ],
        };
      } catch (e) {
        if (!(e instanceof StoreProviderError)) throw e;
        yield {
          items: [
            {
              kind: 'report',
              externalId: 'apple.power_performance.capability',
              content: { state: 'unavailable', reason: e.code },
            },
          ],
        };
      }
    }
    if (task === 'reports' || task === 'vitals') {
      yield* this.reports(app, task, range, signal, imported);
      return;
    }
    if (task === 'catalog') {
      const appData = object(
        object(
          await this.http.api(
            `${API}/apps/${identifier(app)}`,
            this.auth.apple(),
            { signal },
          ),
        ).data,
      );
      const releases = await this.collect(
        `/apps/${identifier(app)}/appStoreVersions`,
        signal,
        { 'filter[platform]': 'IOS' },
      );
      const builds = await this.collect('/builds', signal, {
        'filter[app]': app,
      });
      yield {
        replaceKinds: ['app', 'release', 'build'],
        items: [
          {
            kind: 'app',
            externalId: app,
            content: fields(appData.attributes, [
              'name',
              'bundleId',
              'sku',
              'primaryLocale',
            ]),
          },
          ...releases.map((r) => ({
            kind: 'release' as const,
            externalId: textValue(r.id, 256),
            content: fields(r.attributes, [
              'versionString',
              'platform',
              'appStoreState',
              'createdDate',
              'releaseType',
              'earliestReleaseDate',
            ]),
          })),
          ...builds.map((b) => ({
            kind: 'build' as const,
            externalId: textValue(b.id, 256),
            content: fields(b.attributes, [
              'version',
              'uploadedDate',
              'expirationDate',
              'expired',
              'processingState',
              'minOsVersion',
            ]),
          })),
        ],
      };
      // TestFlight groups are optional capabilities; no tester identities are imported.
      try {
        const groups = await this.collect('/betaGroups', signal, {
          'filter[app]': app,
        });
        yield {
          items: groups.map((g) => ({
            kind: 'build' as const,
            externalId: `betaGroup:${textValue(g.id, 256)}`,
            content: {
              category: 'beta_group',
              ...fields(g.attributes, [
                'name',
                'createdDate',
                'isInternalGroup',
                'hasAccessToAllBuilds',
                'publicLinkEnabled',
              ]),
            },
          })),
        };
      } catch (e) {
        if (!(e instanceof StoreProviderError)) throw e;
        yield {
          items: [
            {
              kind: 'report',
              externalId: 'apple.beta_groups.capability',
              content: { state: 'unavailable', reason: e.code },
            },
          ],
        };
      }
      return;
    }
    for await (const page of this.pages(
      `/apps/${identifier(app)}/customerReviews`,
      signal,
      { include: 'response', sort: '-createdDate' },
    )) {
      const included = new Map(
        list(page.included ?? []).map((r) => [r.id, r.attributes]),
      );
      yield {
        items: page.data.map((review: any): StoreItem => {
          const a = object(review.attributes);
          const response = included.get(
            review.relationships?.response?.data?.id,
          );
          if (!Number.isInteger(a.rating) || a.rating < 1 || a.rating > 5)
            throw new StoreProviderError('INVALID_PROVIDER_RESPONSE');
          return {
            kind: 'review',
            externalId: textValue(review.id, 256),
            content: {
              title: textValue(a.title),
              text: textValue(a.body),
              author: textValue(a.reviewerNickname, 500),
              rating: a.rating,
              territory: textValue(a.territory, 32),
              modifiedAt: textValue(a.createdDate, 100),
              response: response ? textValue(response.responseBody) : null,
              responseState: response ? textValue(response.state, 100) : null,
              responseId: review.relationships?.response?.data?.id
                ? textValue(review.relationships.response.data.id, 256)
                : null,
            },
          };
        }),
      };
    }
  }

  async reply(review: string, text: string, signal: AbortSignal) {
    const result = object(
      await this.http.api(`${API}/customerReviewResponses`, this.auth.apple(), {
        method: 'POST',
        signal,
        data: {
          data: {
            type: 'customerReviewResponses',
            attributes: { responseBody: text },
            relationships: {
              review: { data: { type: 'customerReviews', id: review } },
            },
          },
        },
      }),
    );
    const a = object(object(result.data).attributes);
    return {
      response: textValue(a.responseBody),
      responseState: textValue(a.state, 100),
      responseId: textValue(result.data.id, 256),
    };
  }

  async requestAnalytics(app: string, signal: AbortSignal) {
    const existing = await this.collect(
      `/apps/${identifier(app)}/analyticsReportRequests`,
      signal,
    );
    const active = existing.find(
      (r) =>
        r.attributes?.accessType === 'ONGOING' &&
        !r.attributes?.stoppedDueToInactivity,
    );
    if (active) return;
    await this.http.api(`${API}/analyticsReportRequests`, this.auth.apple(), {
      method: 'POST',
      signal,
      data: {
        data: {
          type: 'analyticsReportRequests',
          attributes: { accessType: 'ONGOING' },
          relationships: { app: { data: { type: 'apps', id: app } } },
        },
      },
    });
  }

  private async *reports(
    app: string,
    task: 'reports' | 'vitals',
    range: StoreRange,
    signal: AbortSignal,
    imported: Set<string>,
  ): AsyncGenerator<StoreBatch> {
    const requests = await this.collect(
      `/apps/${identifier(app)}/analyticsReportRequests`,
      signal,
    );
    if (!requests.length)
      throw new StoreProviderError('APPLE_ANALYTICS_REQUEST_REQUIRED');
    const formats =
      task === 'vitals'
        ? { 'App Crashes': 'apple_crashes' as const }
        : {
            'App Store Downloads': 'apple_downloads' as const,
            'App Store Discovery and Engagement': 'apple_engagement' as const,
            'App Store Installations and Deletions': 'apple_installs' as const,
            'App Installations and Deletions': 'apple_installs' as const,
            'App Sessions': 'apple_sessions' as const,
          };
    let available = false;
    for (const request of requests) {
      const reports = await this.collect(
        `/analyticsReportRequests/${identifier(textValue(request.id, 256))}/reports`,
        signal,
      );
      for (const report of reports) {
        const name = textValue(report.attributes?.name, 256).replace(
          / Standard$/,
          '',
        );
        const format = formats[name as keyof typeof formats];
        if (!format) continue; // Never mix Standard and Detailed: that would double count.
        const reportId = textValue(report.id, 256);
        const instances = await this.collect(
          `/analyticsReports/${identifier(reportId)}/instances`,
          signal,
          { 'filter[granularity]': 'DAILY' },
        );
        // Newer processingDate replaces a COMPLETE day's older records, including corrections.
        const selected = instances
          .filter((i) => i.attributes?.processingDate >= range.from)
          .sort((a, b) =>
            String(a.attributes.processingDate).localeCompare(
              String(b.attributes.processingDate),
            ),
          );
        for (const instance of selected) {
          const instanceId = textValue(instance.id, 256);
          const externalId = `instance:${instanceId}`;
          if (imported.has(externalId)) {
            available = true;
            continue;
          }
          const revision = textValue(instance.attributes.processingDate, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(revision))
            throw new StoreProviderError('REPORT_DATE_INVALID');
          const segments = await this.collect(
            `/analyticsReportInstances/${identifier(instanceId)}/segments`,
            signal,
          );
          if (!segments.length) continue;
          available = true;
          if (segments.length > 20)
            throw new StoreProviderError('REPORT_TOO_LARGE');
          let bytesTotal = 0,
            decodedTotal = 0;
          const rows: Record<string, string>[] = [];
          for (const segment of segments) {
            const a = object(segment.attributes);
            const url = textValue(a.url, 16000);
            let host: string;
            try {
              host = new URL(url).hostname;
            } catch {
              throw new StoreProviderError('REPORT_URL_REJECTED');
            }
            const extra = this.config
              .value('STORE_APPLE_REPORT_HOSTS')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const allowed =
              /^(?:[a-z0-9-]+\.)*apple\.com$/.test(host) ||
              /^asp-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
            if (!allowed && !extra.includes(host))
              throw new StoreProviderError('APPLE_REPORT_HOST_NOT_ALLOWED');
            const bytes = await this.http.report(url, [host], signal);
            bytesTotal += bytes.length;
            if (bytesTotal > 24 * 1024 * 1024)
              throw new StoreProviderError('REPORT_TOO_LARGE');
            if (
              a.sizeInBytes !== undefined &&
              Number(a.sizeInBytes) !== bytes.length
            )
              throw new StoreProviderError('REPORT_SIZE_MISMATCH');
            const checksum = textValue(a.checksum, 128).toLowerCase();
            const algorithm = /^[a-f0-9]{32}$/.test(checksum)
              ? 'md5'
              : /^[a-f0-9]{64}$/.test(checksum)
                ? 'sha256'
                : null;
            if (
              !algorithm ||
              createHash(algorithm).update(bytes).digest('hex') !== checksum
            )
              throw new StoreProviderError('REPORT_CHECKSUM_MISMATCH');
            const decoded = await decodeReport(bytes);
            decodedTotal += Buffer.byteLength(decoded, 'utf8');
            if (decodedTotal > 24 * 1024 * 1024)
              throw new StoreProviderError('REPORT_TOO_LARGE');
            rows.push(...parseReport(decoded, '\t'));
            if (rows.length > 50000)
              throw new StoreProviderError('REPORT_TOO_LARGE');
          }
          // Import the whole instance, including old dates corrected by Apple. Persist its
          // identifier only AFTER every segment passed validation; never store signed URLs.
          const partitions = normalizeReport(rows, {
            format,
            dataset: name,
            appId: app,
            revision,
            range: { from: '2000-01-01', to: day() },
          });
          yield {
            partitions,
            items: [
              {
                kind: 'report',
                externalId,
                content: {
                  name,
                  instanceId,
                  reportId,
                  processingDate: revision,
                  state: 'available',
                  days: partitions.length,
                  segments: segments.length,
                  sourceSegments: segments.map((segment) => ({
                    id: textValue(segment.id, 256),
                    checksum: textValue(segment.attributes?.checksum, 128),
                    sizeInBytes: Number(segment.attributes?.sizeInBytes),
                  })),
                },
              },
            ],
          };
        }
      }
    }
    if (!available) throw new StoreProviderError('REPORTS_NOT_YET_AVAILABLE');
  }
}
