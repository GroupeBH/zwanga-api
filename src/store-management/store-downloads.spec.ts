import { ConfigService } from '@nestjs/config';
import { DOWNLOAD_METRICS, downloadSummary } from './store-downloads';
import { StoreConfig } from './store.config';
import { StoreService } from './store.service';
import type { StoreRepository } from './store.repository';
import type { CacheService } from '../common/services/cache.service';

describe('Store download summary semantics', () => {
  const range = { from: '2026-01-01', to: '2026-01-03' };
  const stamp = '2026-01-05T10:00:00.000Z';
  it('preserves a published zero, missing days, a partial exact total and an independent latest date', () => {
    const latest = { date: '2026-01-04', value: '9.000000', importedAt: stamp };
    const result = downloadSummary(DOWNLOAD_METRICS[0], range, latest, [
      {
        date: '2026-01-01',
        value: '0.000000',
        importedAt: stamp,
        periodValue: '9007199254740993.000000',
      },
      {
        date: '2026-01-03',
        value: '9007199254740993.000000',
        importedAt: stamp,
      },
    ]);
    expect(result.latest).toEqual(latest);
    expect(result.period).toEqual({
      value: '9007199254740993.000000',
      observedDays: 2,
      expectedDays: 3,
      availability: 'partial',
    });
    expect(result.daily.map((d) => d.value)).toEqual([
      '0.000000',
      null,
      '9007199254740993.000000',
    ]);
    expect(result.daily[1].importedAt).toBeNull();
    expect(result.definition.source).toContain('Google');
  });
  it('never invents a zero when reports or the selected dimension are absent', () => {
    const result = downloadSummary(DOWNLOAD_METRICS[1], range, undefined, []);
    expect(result.latest).toBeNull();
    expect(result.period).toMatchObject({
      value: null,
      observedDays: 0,
      availability: 'unavailable',
    });
    expect(result.daily.every((d) => d.value === null)).toBe(true);
  });
  it('keeps an explicitly reported all-zero period available', () => {
    const result = downloadSummary(
      DOWNLOAD_METRICS[2],
      { from: range.from, to: range.from },
      undefined,
      [{ date: range.from, value: '0', periodValue: '0', importedAt: stamp }],
    );
    expect(result.period).toMatchObject({
      value: '0',
      availability: 'available',
    });
  });
  it('does not substitute installations, updates or commercial units for first-time downloads', () => {
    expect(DOWNLOAD_METRICS.map((m) => m.metric)).toEqual([
      'google.device_installs',
      'apple.first_time_downloads',
      'apple.redownloads',
    ]);
  });
  it('rejects disabled reads and invalid periods before reaching SQL or Redis', async () => {
    const make = (enabled: string) =>
      new StoreService(
        new StoreConfig(
          new ConfigService({ STORE_MANAGEMENT_ENABLED: enabled }),
        ),
        {} as StoreRepository,
        {} as CacheService,
      );
    await expect(make('false').downloads(range)).rejects.toThrow('désactivé');
    await expect(
      make('true').downloads({ from: '2026-02-31', to: '2026-03-01' }),
    ).rejects.toThrow('Période invalide');
    await expect(
      make('true').downloads({ from: '2026-01-01', to: '2026-06-01' }),
    ).rejects.toThrow('Période invalide');
  });
});
