import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { storeAnnouncements } from './store-release-announcements.policy';
import { StoreReleaseAnnouncementsService } from './store-release-announcements.service';
import { StoreConfig } from './store.config';
import type { StoreSyncJob } from './store.entities';

const apple = {
  platform: 'IOS',
  versionString: '1.10',
  buildVersion: '20',
  appStoreState: 'READY_FOR_DISTRIBUTION',
  phasedReleaseState: null,
};
const google = {
  status: 'completed',
  name: 'An arbitrary campaign name',
  versionCodes: ['175'],
  userFraction: null,
  countryTargeting: null,
};
describe('Store release announcement eligibility', () => {
  it('uses Google versionCode, never the arbitrary release name', () => {
    expect(
      storeAnnouncements('google', [
        { track: 'production', releases: [google] },
      ]),
    ).toEqual([
      {
        platform: 'android',
        version: '0.0.0',
        build: '175.0.0',
        comparison: 'native_build',
        notes: '',
      },
    ]);
  });
  it.each(['internal', 'alpha', 'beta', 'wear:production'])(
    'ignores Google track %s',
    (track) => {
      expect(
        storeAnnouncements('google', [{ track, releases: [google] }]),
      ).toEqual([]);
    },
  );
  it.each([
    { status: 'inProgress' },
    { status: 'draft' },
    { status: 'halted' },
    { userFraction: 0.2 },
    { countryTargeting: { countries: ['CD'] } },
    { versionCodes: ['175', '176'] },
    { versionCodes: [] },
    { versionCodes: ['invalid'] },
    { versionCodes: ['2147483648'] },
  ])(
    'ignores partial, restricted or ambiguous Google distributions: %j',
    (patch) => {
      expect(
        storeAnnouncements('google', [
          { track: 'production', releases: [{ ...google, ...patch }] },
        ]),
      ).toEqual([]);
    },
  );
  it('selects the highest eligible build, not the first returned track release', () => {
    const rows = storeAnnouncements('google', [
      {
        track: 'production',
        releases: [google, { ...google, versionCodes: ['180'] }],
      },
    ]);
    expect(rows.map((r) => r.build)).toEqual(['180.0.0', '175.0.0']);
  });
  it.each(['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'])(
    'accepts public Apple %s with a known binary',
    (appStoreState) => {
      expect(
        storeAnnouncements('apple', [{ ...apple, appStoreState }]),
      ).toEqual([
        {
          platform: 'ios',
          version: '1.10.0',
          build: '20.0.0',
          comparison: 'version_build',
          notes: '',
        },
      ]);
    },
  );
  it.each([
    { platform: 'MAC_OS' },
    { appStoreState: 'PENDING_DEVELOPER_RELEASE' },
    { appStoreState: 'IN_REVIEW' },
    { appStoreState: 'REMOVED_FROM_SALE' },
    { phasedReleaseState: 'ACTIVE' },
    { phasedReleaseState: 'PAUSED' },
    { phasedReleaseState: {} },
    { buildVersion: null },
    { versionString: 'invalid' },
    { earliestReleaseDate: '2999-01-01T00:00:00Z' },
    { earliestReleaseDate: 'invalid' },
    { earliestReleaseDate: {} },
  ])('ignores unconfirmed Apple distribution: %j', (patch) => {
    expect(storeAnnouncements('apple', [{ ...apple, ...patch }])).toEqual([]);
  });
  it('sorts Apple versions numerically, then their builds', () => {
    const rows = storeAnnouncements('apple', [
      apple,
      { ...apple, versionString: '1.9' },
      { ...apple, buildVersion: '21' },
    ]);
    expect(rows.map((r) => `${r.version}/${r.build}`)).toEqual([
      '1.10.0/21.0.0',
      '1.10.0/20.0.0',
      '1.9.0/20.0.0',
    ]);
  });
  it.each([
    'APP_UPDATES_ENABLED',
    'APP_UPDATES_FROM_STORES_ENABLED',
    'STORE_MANAGEMENT_ENABLED',
  ])('does nothing when %s is disabled', async (key) => {
    const config = new ConfigService({
      APP_UPDATES_ENABLED: 'true',
      APP_UPDATES_FROM_STORES_ENABLED: 'true',
      STORE_MANAGEMENT_ENABLED: 'true',
      STORE_APPLE_APP_ID: '123',
      [key]: 'false',
    });
    const manager = { query: jest.fn(), getRepository: jest.fn() };
    await new StoreReleaseAnnouncementsService(
      config,
      new StoreConfig(config),
    ).catalogSucceeded(
      manager as unknown as EntityManager,
      { task: 'catalog', platform: 'apple', appId: '123' } as StoreSyncJob,
    );
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.getRepository).not.toHaveBeenCalled();
  });
});
