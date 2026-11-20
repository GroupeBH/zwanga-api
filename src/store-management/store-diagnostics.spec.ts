import { ConfigService } from '@nestjs/config';
import { StoreConfig } from './store.config';
import { StoreService } from './store.service';
import { StoreWorker } from './store.worker';
import { StoreIntegration } from './store-operations.entities';
import { StoreSyncJob } from './store.entities';
import { storeSourceDiagnostics } from './store-diagnostics';
import { AppleStoreProvider } from './apple-store.provider';
import { StoreProviderError } from './store.types';

const values = {
  STORE_MANAGEMENT_ENABLED: 'true',
  STORE_SYNC_ENABLED: 'true',
  STORE_GOOGLE_AUTH_MODE: 'service_account',
  STORE_GOOGLE_PACKAGE_NAME: 'com.test',
  STORE_GOOGLE_CLIENT_EMAIL: 'not-a-real-identity',
  STORE_GOOGLE_PRIVATE_KEY: 'private-test-key',
  STORE_APPLE_APP_ID: '123',
  STORE_APPLE_ISSUER_ID: 'test-issuer',
  STORE_APPLE_KEY_ID: 'test-key',
  STORE_APPLE_PRIVATE_KEY: 'private-test-key',
};
const config = (overrides: Record<string, string> = {}) =>
  new StoreConfig(new ConfigService({ ...values, ...overrides }));
const integration = (overrides = {}) =>
  ({
    platform: 'google',
    enabled: true,
    checkedAt: new Date('2026-11-19'),
    capabilities: null,
    schedule: {},
    ...overrides,
  }) as StoreIntegration;

describe('Store source diagnostics and independent integrations (mock providers)', () => {
  it('distinguishes base credentials from report bucket and catalogue opt-in', () => {
    const result = storeSourceDiagnostics(
      config(),
      'google',
      integration(),
      [],
    );
    expect(result.sources.find((s) => s.task === 'reviews')?.state).toBe(
      'unchecked',
    );
    expect(result.sources.find((s) => s.task === 'reports')).toMatchObject({
      state: 'configuration_required',
      reasonCode: 'GOOGLE_REPORTS_BUCKET_NOT_CONFIGURED',
      missingVariables: ['STORE_GOOGLE_REPORTS_BUCKET'],
    });
    expect(result.sources.find((s) => s.task === 'catalog')?.reasonCode).toBe(
      'GOOGLE_CATALOG_TEMPORARY_EDIT_NOT_ALLOWED',
    );
    expect(JSON.stringify(result)).not.toContain('private-test-key');
  });
  it('keeps successful sources usable when another scope is denied', () => {
    const result = storeSourceDiagnostics(
      config({ STORE_GOOGLE_REPORTS_BUCKET: 'pubsite_prod_test' }),
      'google',
      integration({
        capabilities: {
          publisher_reviews_read: { available: true },
          statistics_read: {
            available: false,
            errorCode: 'PROVIDER_PERMISSION_DENIED',
          },
        },
      }),
      [],
    );
    expect(result.sources.find((s) => s.task === 'reviews')?.state).toBe(
      'ready',
    );
    expect(result.sources.find((s) => s.task === 'reports')).toMatchObject({
      state: 'unavailable',
      reasonCode: 'PROVIDER_PERMISSION_DENIED',
    });
  });
  it('shows setup and disabled states explicitly instead of claiming a connection', () => {
    expect(
      storeSourceDiagnostics(config(), 'apple', undefined, []).sources.every(
        (s) => s.reasonCode === 'STORE_INTEGRATION_NOT_INITIALIZED',
      ),
    ).toBe(true);
    expect(
      storeSourceDiagnostics(
        config(),
        'google',
        integration({ enabled: false }),
        [],
      ).sources.every((s) => s.state === 'disabled'),
    ).toBe(true);
    expect(
      storeSourceDiagnostics(
        config({ STORE_GOOGLE_AUTH_MODE: 'unknown' }),
        'google',
        integration(),
        [],
      ).sources[0].reasonCode,
    ).toBe('STORE_INVALID_AUTH_MODE');
  });
  it('does not reuse old successful capabilities after a fatal connection failure', () => {
    const result = storeSourceDiagnostics(
      config(),
      'google',
      integration({
        errorCode: 'GOOGLE_AUTH_FAILED',
        capabilities: { publisher_reviews_read: { available: true } },
      }),
      [],
    );
    expect(result.sources[0]).toMatchObject({
      state: 'unavailable',
      reasonCode: 'GOOGLE_AUTH_FAILED',
    });
  });
  it('prefers a newer successful import to an old denied probe and projects only safe evidence', () => {
    const job = {
      id: 'job',
      task: 'reviews',
      state: 'succeeded',
      processed: 0,
      completedAt: new Date('2026-11-20'),
      input: { reply: 'must-never-leak' },
      leaseToken: 'must-never-leak',
    } as unknown as StoreSyncJob;
    const result = storeSourceDiagnostics(
      config(),
      'google',
      integration({
        capabilities: { publisher_reviews_read: { available: false } },
      }),
      [job],
    );
    expect(result.sources[0]).toMatchObject({
      state: 'ready',
      lastJob: { state: 'succeeded', processed: 0 },
    });
    expect(JSON.stringify(result)).not.toContain('must-never-leak');
  });
  it('rejects a report import before queueing when its separate bucket is missing', async () => {
    const repository = { enqueue: jest.fn() };
    const service = new StoreService(config(), repository as any, {} as any);
    await expect(
      service.sync('actor', 'google', {
        task: 'reports',
        requestId: 'request',
        from: '2026-11-01',
        to: '2026-11-19',
      } as any),
    ).rejects.toMatchObject({
      response: { code: 'GOOGLE_REPORTS_BUCKET_NOT_CONFIGURED' },
    });
    expect(repository.enqueue).not.toHaveBeenCalled();
  });
  it('schedules other Google and Apple sources while explicit prerequisites are absent', async () => {
    const repository = {
      enqueue: jest.fn(),
      db: { getRepository: () => ({ findOneBy: async () => integration() }) },
    };
    const worker = new StoreWorker(
      config(),
      repository as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await worker.schedule();
    expect(
      repository.enqueue.mock.calls
        .filter(([j]) => j.platform === 'google')
        .map(([j]) => j.task)
        .sort(),
    ).toEqual(['connection', 'reviews', 'vitals']);
    expect(
      repository.enqueue.mock.calls.filter(([j]) => j.platform === 'apple'),
    ).toHaveLength(5);
  });
  it('reads only current app history and excludes reply / analytics write jobs from diagnostics', async () => {
    const builders: any[] = [];
    const repository = {
      db: {
        getRepository: (entity: unknown) =>
          entity === StoreIntegration
            ? {
                find: async () => [
                  integration({
                    capabilities: {
                      publisher_reviews_read: { available: true },
                    },
                  }),
                ],
              }
            : {
                createQueryBuilder: () => {
                  const qb: any = {};
                  for (const name of [
                    'select',
                    'where',
                    'andWhere',
                    'distinctOn',
                    'orderBy',
                    'addOrderBy',
                  ])
                    qb[name] = jest.fn(() => qb);
                  qb.getMany = jest.fn().mockResolvedValue([]);
                  builders.push(qb);
                  return qb;
                },
              },
      },
    };
    const result = await new StoreService(
      config(),
      repository as any,
      {} as any,
    ).diagnostics();
    expect(result.platforms).toHaveLength(2);
    expect(result.platforms[0].checkedAt).toBeNull();
    expect(result.platforms[0].sources[0].state).toBe('unchecked');
    expect(builders[0].where).toHaveBeenCalledWith(expect.any(String), {
      platform: 'google',
      appId: 'com.test',
    });
    expect(builders[1].where).toHaveBeenCalledWith(expect.any(String), {
      platform: 'apple',
      appId: '123',
    });
    for (const qb of builders) {
      expect(qb.select.mock.calls[0][0]).not.toContain('j.input');
      expect(qb.andWhere.mock.calls[0][1].tasks).toEqual([
        'reviews',
        'catalog',
        'reports',
        'vitals',
        'connection',
      ]);
    }
  });
  it('probes Apple versions separately and distinguishes readable analytics from requested reports', async () => {
    const http = {
      api: jest.fn(async (url: string) => {
        if (url.includes('appStoreVersions'))
          throw new StoreProviderError('PROVIDER_PERMISSION_DENIED');
        return { data: [] };
      }),
    };
    const provider = new AppleStoreProvider(
      { apple: () => 'test-token' } as any,
      http as any,
      config(),
    );
    const batches: any[] = [];
    for await (const batch of provider.sync(
      '123',
      'connection',
      { from: '2026-11-01', to: '2026-11-19' },
      new AbortController().signal,
      new Set(),
    ))
      batches.push(batch);
    expect(batches[0].integrationCheck).toMatchObject({
      application_read: { available: true },
      versions_read: {
        available: false,
        errorCode: 'PROVIDER_PERMISSION_DENIED',
      },
      analytics_read: { available: true },
      analytics_reports_requested: {
        available: false,
        errorCode: 'APPLE_ANALYTICS_REQUEST_REQUIRED',
      },
    });
    expect(http.api.mock.calls.every((call: any[]) => !call[2].method)).toBe(
      true,
    );
  });
});
