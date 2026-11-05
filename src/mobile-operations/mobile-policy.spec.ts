import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  campaignCategory,
  compareBuild,
  nativeBuild,
  policyDecision,
  validStoreUrl,
} from './mobile-policy';
import {
  MobileCampaignDto,
  MobileInstallationDto,
  MobilePolicyDto,
  MobileRevisionDto,
} from './mobile.dto';
import { requestHash } from './mobile-audit';
import { appleSalesPartition } from '../store-management/apple-sales';
import { GooglePlayProvider } from '../store-management/google-play.provider';
import { StoreConfig } from '../store-management/store.config';
import { ConfigService } from '@nestjs/config';

describe('Mobile policy and consent contracts', () => {
  it.each([
    ['145', '146', -1],
    ['145', '145.0', 0],
    ['9.9', '10', -1],
    ['2.10', '2.9', 1],
    ['2147483647', '1', 1],
  ])('compares native builds %s and %s', (a, b, c) =>
    expect(compareBuild(a, b)).toBe(c),
  );
  it.each(['-1', 'NaN', '1e3', '2147483648', '1.2.3.4'])(
    'rejects unsafe build %s',
    (v) => expect(() => nativeBuild(v)).toThrow(),
  );
  it('does not interrupt a ride or require a build when its release is unavailable', () => {
    const p = {
      id: 'policy',
      available: true,
      availabilityConfirmed: true,
      build: '150.0.0',
      version: '1.0.17',
      minimumBuild: '145',
      mode: 'REQUIRED',
      blockedFeatures: ['accept_request'],
    };
    expect(policyDecision(p, '144')).toMatchObject({
      required: true,
      blockedFeatures: ['accept_request'],
      protectedOperations: ['ongoing_trip', 'finish_trip', 'safety', 'support'],
    });
    expect(policyDecision(p, '145')).toMatchObject({
      required: false,
      mode: 'RECOMMENDED',
      blockedFeatures: [],
    });
    expect(policyDecision({ ...p, available: false }, '144')).toMatchObject({
      required: false,
      mode: 'NONE',
    });
    expect(policyDecision(p, '151')).toMatchObject({
      updateAvailable: false,
      required: false,
    });
  });
  it.each(['information', 'feature', 'signup', 'marketing'])(
    '%s requires marketing consent',
    (kind) => expect(campaignCategory(kind)).toBe('marketing'),
  );
  it('accepts only the actual HTTPS store listings', () => {
    expect(
      validStoreUrl(
        'android',
        'https://play.google.com/store/apps/details?id=com.zwanga',
      ),
    ).toBe(true);
    expect(
      validStoreUrl('ios', 'https://apps.apple.com/app/id6756211830'),
    ).toBe(true);
    for (const url of [
      'https://evil.test/app/id6756211830',
      'https://apps.apple.com@evil.test/app/id6756211830',
      'http://apps.apple.com/app/id6756211830',
      'https://apps.apple.com/app/id1',
    ])
      expect(validStoreUrl('ios', url)).toBe(false);
  });
  it('hashes idempotency data independent of property order without omitting nested fields', () => {
    expect(requestHash({ a: 1, b: { d: 3, c: 2 } })).toBe(
      requestHash({ b: { c: 2, d: 3 }, a: 1 }),
    );
    expect(requestHash({ b: { d: 3, c: 2 } })).not.toBe(
      requestHash({ b: { d: 3, c: 4 } }),
    );
  });
  it('rejects string consent and arbitrary user IDs under the public DTO', async () => {
    const dto = plainToInstance(
      MobileInstallationDto,
      {
        platform: 'android',
        version: '1',
        build: '145',
        sequence: 1,
        enabled: false,
        environment: 'production',
        notificationPermission: 'denied',
        pushProvider: 'fcm',
        preferences: { operational: false, updates: false, marketing: 'false' },
        userId: 'forged',
      },
      { enableImplicitConversion: true },
    );
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((e) => e.property)).toEqual(
      expect.arrayContaining(['preferences', 'userId']),
    );
  });
  it('rejects hazardous policy features and unconfirmed operations', async () => {
    expect(
      (
        await validate(
          plainToInstance(MobilePolicyDto, {
            blockedFeatures: ['finish_trip'],
          }),
        )
      ).some((e) => e.property === 'blockedFeatures'),
    ).toBe(true);
    expect(
      (
        await validate(
          plainToInstance(
            MobileRevisionDto,
            { revision: 1, confirmed: 'true' },
            { enableImplicitConversion: true },
          ),
        )
      ).some((e) => e.property === 'confirmed'),
    ).toBe(true);
    expect(
      (
        await validate(
          plainToInstance(MobileCampaignDto, {
            audience: { environment: 'production', population: 'admin' },
          }),
        )
      ).some((e) => e.property === 'audience'),
    ).toBe(true);
  });
});
describe('Store restrictions and commercial metric normalization', () => {
  it('does not create Google edits by default', async () => {
    const http = { api: jest.fn() },
      provider = new GooglePlayProvider(
        { google: jest.fn(async () => 'mock') } as any,
        http as any,
        new StoreConfig(new ConfigService({})),
      );
    await expect(
      provider
        .sync(
          'com.zwanga',
          'catalog',
          { from: '2026-01-01', to: '2026-01-01' },
          AbortSignal.timeout(1000),
        )
        .next(),
    ).rejects.toThrow('GOOGLE_CATALOG_TEMPORARY_EDIT_NOT_ALLOWED');
    expect(http.api).not.toHaveBeenCalled();
  });
  it('keeps sales units, credits, product types and unrelated applications separate', () => {
    const header =
      'Begin Date\tEnd Date\tApple Identifier\tUnits\tProduct Type Identifier\tCountry Code\tVersion\n';
    const row = (app: string, n: string, type: string) =>
      `11/01/2026\t11/01/2026\t${app}\t${n}\t${type}\tCD\t1.0\n`;
    const p = appleSalesPartition(
      header +
        row('6756211830', '3', '1F') +
        row('6756211830', '-1', '1F') +
        row('123', '99', '1F'),
      '6756211830',
      '2026-11-01',
      'now',
    );
    expect(p.points.map((p) => [p.metric, p.value])).toEqual([
      ['apple.sales_units', 3],
      ['apple.sales_return_units', 1],
    ]);
    expect(() =>
      appleSalesPartition(
        header + row('6756211830', 'NaN', '1F'),
        '6756211830',
        '2026-11-01',
        'now',
      ),
    ).toThrow();
  });
});
