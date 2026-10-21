import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, verify } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StoreAuth } from './store.auth';
import { StoreConfig } from './store.config';
import { decodeReport, providerFailure, StoreHttp } from './store.http';
import { normalizeReport, parseReport } from './store.reports';
import { storeRange, StoreReplyDto, StoreSyncDto } from './store.dto';
import { GooglePlayProvider } from './google-play.provider';
import { AppleStoreProvider } from './apple-store.provider';
import { StoreWorker } from './store.worker';
import { StoreProviderError } from './store.types';
import { storePermissions } from './store.permissions';
import { StoreAlertRulePatchDto } from './store-operations.dto';
import { UserRole } from '../users/entities/user.entity';

describe('Store Management policies, bounded import and authentication', () => {
  it('is inert by default and exposes no credentials', async () => {
    const config = new StoreConfig(
      new ConfigService({ STORE_APPLE_PRIVATE_KEY: 'secret' }),
    );
    const repo = { claim: jest.fn(), enqueue: jest.fn() };
    const worker = new StoreWorker(
      config,
      repo as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await worker.schedule();
    await worker.tick();
    await worker.onModuleDestroy();
    expect(config.enabled).toBe(false);
    expect(repo.claim).not.toHaveBeenCalled();
    expect(repo.enqueue).not.toHaveBeenCalled();
    expect(() => config.assertReady('apple')).toThrow(
      'Store Management est désactivé.',
    );
  });
  it.each([UserRole.PASSENGER, UserRole.DRIVER, UserRole.MARKETER, 'unknown'])(
    'denies Store permissions to %s',
    (role) => {
      expect(storePermissions(role)).toEqual([]);
    },
  );
  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    'extends existing admin permissions: %s',
    (role) => {
      expect(storePermissions(role)).toContain('store.reviews.read');
      expect(storePermissions(role).includes('store.reviews.reply')).toBe(
        role === UserRole.SUPER_ADMIN,
      );
    },
  );
  it('signs Apple tokens with P-256 ES256 in JOSE format, no private key in payload', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const config = new StoreConfig(
      new ConfigService({
        STORE_APPLE_PRIVATE_KEY: privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        STORE_APPLE_KEY_ID: 'key-id',
        STORE_APPLE_ISSUER_ID: 'issuer-id',
      }),
    );
    const auth = new StoreAuth(config);
    const token = auth.apple();
    const [header, payload, signature] = token.split('.');
    expect(
      JSON.parse(Buffer.from(header, 'base64url').toString()),
    ).toMatchObject({ alg: 'ES256', kid: 'key-id' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: 'issuer-id',
      aud: 'appstoreconnect-v1',
    });
    expect(claims.exp - claims.iat).toBeLessThan(1200);
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    expect(auth.apple()).toBe(token);
  });
  it('sanitizes credential errors', () => {
    expect(() =>
      new StoreAuth(
        new StoreConfig(
          new ConfigService({ STORE_APPLE_PRIVATE_KEY: 'do-not-log-secret' }),
        ),
      ).apple(),
    ).toThrow('APPLE_AUTH_CONFIGURATION_INVALID');
    const error = providerFailure({
      isAxiosError: true,
      config: { headers: { Authorization: 'secret' } },
      response: { status: 429, headers: { 'retry-after': '120' } },
    });
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.retryable).toBe(true);
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(
      providerFailure({ isAxiosError: true, response: { status: 502 } }, true)
        .ambiguous,
    ).toBe(true);
  });
  it.each([
    { to: 'bad' },
    { to: '2026-02-30' },
    { from: '2025-01-01', to: '2026-01-01' },
    { from: '2026-01-02', to: '2026-01-01' },
  ])('rejects invalid date ranges without a 500: %j', (input) => {
    expect(() => storeRange(input)).toThrow();
  });
  it('preserves strict DTO types despite global implicit conversion', async () => {
    expect(
      await validate(
        plainToInstance(StoreAlertRulePatchDto, { enabled: false }),
      ),
    ).toHaveLength(0);
    for (const value of [null, 'false', 0]) {
      expect(
        (
          await validate(
            plainToInstance(
              StoreAlertRulePatchDto,
              { enabled: value },
              { enableImplicitConversion: true },
            ),
          )
        ).some((e) => e.property === 'enabled'),
      ).toBe(true);
    }
    const dto = plainToInstance(
      StoreSyncDto,
      { task: 123, requestId: {}, from: '2026-01-01' },
      { enableImplicitConversion: true },
    );
    expect((await validate(dto)).length).toBeGreaterThan(0);
    const reply = plainToInstance(
      StoreReplyDto,
      { text: 123, requestId: '10000000-0000-4000-8000-000000000001' },
      { enableImplicitConversion: true },
    );
    expect((await validate(reply)).some((e) => e.property === 'text')).toBe(
      true,
    );
  });
  it('parses CSV escaped quotes, commas, BOM, multiline cells and TSV', async () => {
    const text =
      'Date,Package Name,Note\r\n2026-01-01,com.test,"comma, quote "" and\nnewline"\r\n';
    const decoded = await decodeReport(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    );
    expect(parseReport(decoded, ',')[0].note).toBe(
      'comma, quote " and\nnewline',
    );
    expect(
      parseReport(
        await decodeReport(gzipSync('Date\tCounts\n2026-01-01\t2\n')),
        '\t',
      )[0].counts,
    ).toBe('2');
  });
  it.each([
    'Date,Date\n1,2',
    'Date,A\n2026-01-01,"unterminated',
    'Date,A\n2026-01-01,"x"bad',
    'Date,A\n2026-01-01',
  ])('rejects malformed reports', (text) => {
    expect(() => parseReport(text, ',')).toThrow(StoreProviderError);
  });
  it('bounds gzip expansion', async () => {
    await expect(
      decodeReport(gzipSync(Buffer.alloc(13 * 1024 * 1024, 65))),
    ).rejects.toThrow('REPORT_ENCODING_OR_SIZE_INVALID');
  });
  const reportOptions = {
    format: 'apple_downloads' as const,
    appId: '123',
    dataset: 'App Store Downloads',
    revision: '2026-01-03',
    range: { from: '2026-01-01', to: '2026-01-02' },
  };
  it('aggregates only disjoint count rows and does not mix updates into first downloads', () => {
    const row = {
      date: '2026-01-01',
      'app apple identifier': '123',
      territory: 'COD',
      'source type': 'App Store search',
      'download type': 'First-time Download',
      counts: '4',
    };
    const partitions = normalizeReport(
      [
        row,
        { ...row, counts: '3' },
        { ...row, counts: '8', 'download type': 'Auto-update' },
      ],
      reportOptions,
    );
    expect(
      partitions[0].points.find(
        (p) => p.metric === 'apple.first_time_downloads',
      )?.value,
    ).toBe(7);
    expect(
      partitions[0].points.find((p) => p.metric === 'apple.updates')?.value,
    ).toBe(8);
  });
  it('keeps suppressed counts missing and rejects another app', () => {
    const row = {
      date: '2026-01-01',
      'app apple identifier': '123',
      'download type': 'First-time Download',
      counts: '',
    };
    expect(normalizeReport([row], reportOptions)[0].points).toEqual([]);
    expect(() =>
      normalizeReport(
        [{ ...row, 'app apple identifier': '456' }],
        reportOptions,
      ),
    ).toThrow('REPORT_APP_MISMATCH');
  });
});

describe('Store providers (mocked HTTP, no real credentials)', () => {
  const signal = AbortSignal.timeout(60000);
  const range = { from: '2026-01-01', to: '2026-01-03' };
  const collect = async (iterator: AsyncIterable<unknown>) => {
    const result: unknown[] = [];
    for await (const batch of iterator) result.push(batch);
    return result;
  };
  const auth = {
    google: jest.fn(async () => 'test-token'),
    apple: () => 'test-token',
  };
  let http: { api: jest.Mock; report: jest.Mock };
  let google: GooglePlayProvider, apple: AppleStoreProvider;
  beforeEach(() => {
    http = { api: jest.fn(), report: jest.fn() };
    const config = new StoreConfig(
      new ConfigService({ STORE_GOOGLE_REPORTS_BUCKET: 'pubsite_prod_test' }),
    );
    google = new GooglePlayProvider(auth as any, http as any, config);
    apple = new AppleStoreProvider(auth as any, http as any, config);
  });
  it('reads tracks in a temporary edit, deletes it, NEVER commits or publishes', async () => {
    http.api
      .mockResolvedValueOnce({ id: 'temporary' })
      .mockResolvedValueOnce({ defaultLanguage: 'fr' })
      .mockResolvedValueOnce({
        tracks: [
          {
            track: 'production',
            releases: [{ status: 'completed', versionCodes: ['145'] }],
          },
        ],
      })
      .mockResolvedValueOnce(undefined);
    const batches = await collect(
      google.sync('com.test', 'catalog', range, signal),
    );
    expect(batches).toHaveLength(1);
    expect(http.api.mock.calls.at(-1)?.[2].method).toBe('DELETE');
    expect(
      http.api.mock.calls.some(
        ([url]) => url.includes(':commit') || url.includes(':validate'),
      ),
    ).toBe(false);
  });
  it('cleans up edits even on a failed tracks read', async () => {
    http.api
      .mockResolvedValueOnce({ id: 'temporary' })
      .mockRejectedValueOnce(new StoreProviderError('FAILED'))
      .mockResolvedValueOnce({ tracks: [] })
      .mockResolvedValueOnce(undefined);
    await expect(
      collect(google.sync('com.test', 'catalog', range, signal)),
    ).rejects.toThrow('FAILED');
    expect(http.api.mock.calls.at(-1)?.[2].method).toBe('DELETE');
  });
  it('follows Google review tokens and preserves the limitation of recent reviews', async () => {
    http.api
      .mockResolvedValueOnce({
        reviews: [],
        tokenPagination: { nextPageToken: 'next' },
      })
      .mockResolvedValueOnce({
        reviews: [
          {
            reviewId: 'a',
            comments: [{ userComment: { text: 'Hello', starRating: 4 } }],
          },
        ],
      });
    const batches: any = await collect(
      google.sync('com.test', 'reviews', range, signal),
    );
    expect(http.api.mock.calls[1][2].params.token).toBe('next');
    expect(batches[1].items[0].content.coverage).toContain('recent');
  });
  it('refuses to follow Apple pagination onto a different host or path', async () => {
    http.api.mockResolvedValue({
      data: [],
      links: { next: 'https://evil.example/steal' },
    });
    await expect(
      collect(apple.pages('/apps/123/customerReviews', signal)),
    ).rejects.toThrow('PROVIDER_PAGINATION_URL_REJECTED');
    expect(http.api).toHaveBeenCalledTimes(1);
  });
  it('does not create Apple report requests as a side effect of reading analytics', async () => {
    http.api.mockResolvedValue({ data: [] });
    await expect(
      collect(apple.sync('123', 'reports', range, signal, new Set())),
    ).rejects.toThrow('APPLE_ANALYTICS_REQUEST_REQUIRED');
    expect(http.api.mock.calls.every((call) => !call[2].method)).toBe(true);
  });
  it('does not send an overlong Google reply', async () => {
    await expect(
      google.reply('com.test', 'review', 'a'.repeat(351), signal),
    ).rejects.toThrow('GOOGLE_REPLY_TOO_LONG');
    expect(http.api).not.toHaveBeenCalled();
  });
  it('rejects non-allowlisted API destinations before any authenticated HTTP call', async () => {
    await expect(
      new StoreHttp().api('https://attacker.example', 'secret'),
    ).rejects.toBeInstanceOf(StoreProviderError);
  });
});
