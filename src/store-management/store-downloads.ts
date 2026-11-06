import { METRIC_CATALOG } from './store.reports';
import { StorePlatform, StoreRange } from './store.types';

// These are deliberately separate: an Android install is not an Apple download.
export const DOWNLOAD_METRICS = [
  {
    platform: 'google',
    metric: 'google.device_installs',
    label: 'Installations Android',
  },
  {
    platform: 'apple',
    metric: 'apple.first_time_downloads',
    label: 'Premiers téléchargements iOS',
  },
  {
    platform: 'apple',
    metric: 'apple.redownloads',
    label: 'Retéléchargements iOS',
  },
] as const;

export interface DownloadDay {
  date: string;
  value: string;
  importedAt: Date | string;
  periodValue?: string;
}

export function downloadSummary(
  definition: (typeof DOWNLOAD_METRICS)[number],
  range: StoreRange,
  latest: DownloadDay | undefined,
  rows: DownloadDay[],
) {
  const days =
    Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
  const observed = new Map(rows.map((row) => [row.date, row]));
  const point = (row: DownloadDay) => ({
    date: row.date,
    value: row.value,
    importedAt: new Date(row.importedAt).toISOString(),
  });
  return {
    ...definition,
    definition: METRIC_CATALOG.find((entry) => entry.id === definition.metric)!,
    latest: latest ? point(latest) : null,
    period: {
      value: rows[0]?.periodValue ?? null,
      observedDays: observed.size,
      expectedDays: days,
      availability: !rows.length
        ? 'unavailable'
        : observed.size < days
          ? 'partial'
          : 'available',
    },
    daily: Array.from({ length: days }, (_, offset) => {
      const date = new Date(Date.parse(range.from) + offset * 86400000)
        .toISOString()
        .slice(0, 10);
      const row = observed.get(date);
      return row ? point(row) : { date, value: null, importedAt: null };
    }),
  };
}

export interface StoreDownloads {
  from: string;
  to: string;
  generatedAt: string;
  filters: {
    platform: StorePlatform | null;
    country: string | null;
    version: string | null;
  };
  latestScope: 'all_imported_dates_with_selected_dimensions';
  comparableAcrossStores: false;
  metrics: ReturnType<typeof downloadSummary>[];
}
