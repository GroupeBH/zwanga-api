import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';
import { gzipSync } from 'node:zlib';
import { StoreAuth } from '../store-management/store.auth';
import { StoreConfig } from '../store-management/store.config';
import { AppleStoreProvider } from '../store-management/apple-store.provider';
import { StoreProviderError } from '../store-management/store.types';

describe('Mobile provider additions, without any external requests', () => {
  afterEach(() => jest.restoreAllMocks());
  it('supports trusted ADC without requiring a service account private key, and masks authentication errors', async () => {
    const token = jest
      .spyOn(GoogleAuth.prototype, 'getAccessToken')
      .mockResolvedValue('synthetic-access-token');
    const config = new StoreConfig(
      new ConfigService({
        STORE_GOOGLE_AUTH_MODE: 'adc',
        STORE_GOOGLE_PACKAGE_NAME: 'com.zwanga',
        GOOGLE_APPLICATION_CREDENTIALS: '/trusted/test-config.json',
      }),
    );
    const auth = new StoreAuth(config);
    expect(config.missing('google')).toEqual([]);
    expect(await auth.google('publisher')).toBe('synthetic-access-token');
    token.mockRejectedValue(new Error('sensitive provider diagnostics'));
    await expect(auth.google('publisher')).rejects.toThrow(
      'GOOGLE_AUTH_FAILED',
    );
  });
  it('associates Apple builds and phased releases without inventing territory availability', async () => {
    const api = jest.fn(async (url: string) =>
      url.endsWith('/appStoreVersions')
        ? {
            data: [
              {
                id: 'version',
                attributes: {
                  versionString: '2.0',
                  appStoreState: 'READY_FOR_DISTRIBUTION',
                },
                relationships: {
                  build: { data: { id: 'build' } },
                  appStoreVersionPhasedRelease: { data: { id: 'phase' } },
                },
              },
            ],
            included: [
              { type: 'builds', id: 'build', attributes: { version: '200' } },
              {
                type: 'appStoreVersionPhasedReleases',
                id: 'phase',
                attributes: { phasedReleaseState: 'ACTIVE' },
              },
            ],
          }
        : url.endsWith('/builds')
          ? { data: [] }
          : {
              data: {
                id: '6756211830',
                attributes: { bundleId: 'com.biso.zwanga' },
              },
            },
    );
    const provider = new AppleStoreProvider(
      { apple: () => 'mock' } as any,
      { api } as any,
      new StoreConfig(new ConfigService({})),
    );
    const result = await provider
      .sync(
        '6756211830',
        'catalog',
        { from: '2026-11-01', to: '2026-11-01' },
        AbortSignal.timeout(1000),
        new Set(),
      )
      .next();
    expect(
      result.value.items.find((x) => x.kind === 'release').content,
    ).toMatchObject({
      buildVersion: '200',
      phasedReleaseState: 'ACTIVE',
      territoryAvailability: null,
    });
  });
  it('decodes a Sales and Trends gzip and keeps unavailable days explicit', async () => {
    const report =
      'Begin Date\tEnd Date\tApple Identifier\tUnits\tProduct Type Identifier\tCountry Code\n11/01/2026\t11/01/2026\t6756211830\t2\t1F\tCD\n';
    const api = jest.fn().mockResolvedValueOnce(gzipSync(report));
    const provider = new AppleStoreProvider(
      { apple: () => 'mock' } as any,
      { api } as any,
      new StoreConfig(
        new ConfigService({
          STORE_APPLE_SALES_REPORTS_ENABLED: 'true',
          STORE_APPLE_VENDOR_NUMBER: '123456',
        }),
      ),
    );
    const request = () =>
      provider
        .sync(
          '6756211830',
          'reports',
          { from: '2026-11-01', to: '2026-11-01' },
          AbortSignal.timeout(1000),
          new Set(),
        )
        .next();
    const result = await request();
    expect(result.value.partitions[0].points[0]).toMatchObject({
      metric: 'apple.sales_units',
      value: 2,
    });
    expect(api.mock.calls[0][2].params).toMatchObject({
      'filter[reportType]': 'SALES',
      'filter[reportSubType]': 'SUMMARY',
      'filter[reportDate]': '2026-11-01',
    });
    api.mockRejectedValueOnce(
      new StoreProviderError('PROVIDER_DATA_UNAVAILABLE'),
    );
    const unavailable = await request();
    expect(unavailable.value.partitions).toBeUndefined();
    expect(unavailable.value.items[0].content.state).toBe('unavailable');
  });
});
