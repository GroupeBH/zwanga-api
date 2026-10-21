import {
  StorePartition,
  StorePoint,
  StoreProviderError,
  StoreRange,
  day,
} from './store.types';

/** Bounded RFC4180-style parser; also accepts Apple's tab-separated segments. */
export function parseReport(
  text: string,
  delimiter: ',' | '\t',
): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const pushCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
    if (row.length > 100)
      throw new StoreProviderError('REPORT_TOO_MANY_COLUMNS');
  };
  const pushRow = () => {
    pushCell();
    if (row.some((v) => v !== '')) rows.push(row);
    row = [];
    if (rows.length > 50001) throw new StoreProviderError('REPORT_TOO_LARGE');
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === delimiter) pushCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || ch === '"')
        throw new StoreProviderError('REPORT_MALFORMED');
      cell += ch;
    }
    if (cell.length > 20000)
      throw new StoreProviderError('REPORT_CELL_TOO_LARGE');
  }
  if (quoted) throw new StoreProviderError('REPORT_MALFORMED');
  if (cell || row.length || closed) pushRow();
  const headers =
    rows.shift()?.map((h) => h.trim().replace(/\s+/g, ' ').toLowerCase()) ?? [];
  if (!headers.includes('date') || new Set(headers).size !== headers.length)
    throw new StoreProviderError('REPORT_SCHEMA_UNSUPPORTED');
  return rows.map((values) => {
    if (values.length !== headers.length)
      throw new StoreProviderError('REPORT_MALFORMED');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

function count(value: string | undefined): number | null {
  // Empty/suppressed data is missing, never a fabricated zero.
  if (value === undefined || value === '' || value === '-' || value === '*')
    return null;
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new StoreProviderError('REPORT_NUMBER_INVALID');
  const n = Number(value);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER)
    throw new StoreProviderError('REPORT_NUMBER_INVALID');
  return n;
}
const METRICS = [
  {
    id: 'google.device_installs',
    unit: 'count',
    aggregation: 'sum',
    description:
      'Installations journalières sur appareils (pas des utilisateurs uniques).',
  },
  {
    id: 'google.user_installs',
    unit: 'count',
    aggregation: 'sum',
    description:
      'Installations utilisateurs Google Play selon le rapport source.',
  },
  {
    id: 'google.device_uninstalls',
    unit: 'count',
    aggregation: 'sum',
    description: 'Désinstallations journalières sur appareils.',
  },
  {
    id: 'google.store_visitors',
    unit: 'count',
    aggregation: 'sum',
    description: 'Visiteurs de la fiche, ventilation par pays.',
  },
  {
    id: 'google.store_acquisitions',
    unit: 'count',
    aggregation: 'sum',
    description: 'Acquisitions de la fiche, ventilation par pays.',
  },
  {
    id: 'apple.first_time_downloads',
    unit: 'count',
    aggregation: 'sum',
    description:
      'Premier téléchargement selon le compte Apple ; différent des installations Google.',
  },
  {
    id: 'apple.redownloads',
    unit: 'count',
    aggregation: 'sum',
    description: 'Téléchargements répétés, sans mises à jour.',
  },
  {
    id: 'apple.updates',
    unit: 'count',
    aggregation: 'sum',
    description: 'Mises à jour manuelles et automatiques.',
  },
  {
    id: 'apple.engagement_events',
    unit: 'count',
    aggregation: 'sum',
    description: 'Événements par type/source, pas des utilisateurs uniques.',
  },
  {
    id: 'apple.crashes',
    unit: 'count',
    aggregation: 'sum',
    description:
      'Crashes des utilisateurs ayant consenti, avec seuils de confidentialité Apple.',
  },
  {
    id: 'google.installed_base',
    unit: 'devices',
    aggregation: 'last_day',
    description: 'Base installée observée ; ne jamais additionner les jours.',
  },
  {
    id: 'google.active_installed_devices',
    unit: 'devices',
    aggregation: 'last_day',
    description:
      'Installations sur appareils actifs ; ce ne sont pas les utilisateurs actifs de Zwanga.',
  },
  {
    id: 'google.crashes',
    unit: 'count',
    aggregation: 'sum',
    description:
      'Crashes journaliers du rapport Google Play Console, distincts du taux Android Vitals.',
  },
  {
    id: 'google.anrs',
    unit: 'count',
    aggregation: 'sum',
    description: 'ANR journaliers du rapport Google Play Console.',
  },
  {
    id: 'apple.impressions',
    unit: 'count',
    aggregation: 'sum',
    description: 'Impressions de la fiche ; pas des visiteurs uniques.',
  },
  {
    id: 'apple.product_page_views',
    unit: 'count',
    aggregation: 'sum',
    description: 'Vues de la page produit, selon le rapport Apple.',
  },
  {
    id: 'apple.installations',
    unit: 'count',
    aggregation: 'sum',
    description: 'Installations sur appareils des utilisateurs consentants.',
  },
  {
    id: 'apple.deletions',
    unit: 'count',
    aggregation: 'sum',
    description: 'Suppressions sur appareils des utilisateurs consentants.',
  },
  {
    id: 'apple.sessions',
    unit: 'count',
    aggregation: 'sum',
    description:
      'Sessions des utilisateurs consentants ; seuils de confidentialité Apple.',
  },
  {
    id: 'apple.session_seconds',
    unit: 'seconds',
    aggregation: 'sum',
    description: 'Durée totale des sessions observées.',
  },
  ...[
    'crashRate',
    'userPerceivedCrashRate',
    'anrRate',
    'userPerceivedAnrRate',
  ].map((name) => ({
    id: `google.${name}`,
    unit: 'provider_percentage',
    aggregation: 'none',
    description:
      'Taux journalier Android Vitals ; ne pas additionner ni moyenner sans pondération.',
  })),
];
const OFFICIAL_NAMES: Record<string, string> = {
  'google.device_installs': 'Daily Device Installs',
  'google.user_installs': 'Daily User Installs',
  'google.device_uninstalls': 'Daily Device Uninstalls',
  'google.store_visitors': 'Store listing visitors',
  'google.store_acquisitions': 'Store listing acquisitions',
  'apple.first_time_downloads': 'First-time Download / Counts',
  'apple.redownloads': 'Redownload / Counts',
  'apple.updates': 'Auto-update + Manual update / Counts',
  'apple.engagement_events': 'Counts (by engagement type)',
  'apple.crashes': 'Crashes',
  'google.installed_base': 'Current Device Installs',
  'google.active_installed_devices': 'Installs on active devices',
  'google.crashes': 'Daily Crashes',
  'google.anrs': 'Daily ANRs',
  'apple.impressions': 'Impression / Counts',
  'apple.product_page_views': 'Page view / Product page / Counts',
  'apple.installations': 'Install / Counts',
  'apple.deletions': 'Delete / Counts',
  'apple.sessions': 'Sessions',
  'apple.session_seconds': 'Total Session Duration',
};
export const METRIC_CATALOG = METRICS.map((m) => ({
  ...m,
  officialName: OFFICIAL_NAMES[m.id] ?? m.id.split('.')[1],
  granularity: 'daily',
  source: m.id.startsWith('apple.')
    ? 'App Store Connect Analytics Reports API'
    : m.aggregation === 'none'
      ? 'Google Play Developer Reporting API'
      : 'Google Play Console CSV / Cloud Storage',
  timezone: m.id.startsWith('apple.')
    ? 'provider_report_reference'
    : m.aggregation === 'none'
      ? 'America/Los_Angeles'
      : 'provider_report_reference',
  missingValue: null,
  comparableAcrossStores: false,
}));

export function normalizeReport(
  rows: Record<string, string>[],
  options: {
    format:
      | 'google_installs'
      | 'google_acquisitions'
      | 'google_crashes'
      | 'apple_downloads'
      | 'apple_engagement'
      | 'apple_crashes'
      | 'apple_sessions'
      | 'apple_installs';
    appId: string;
    dataset: string;
    revision: string;
    range: StoreRange;
  },
): StorePartition[] {
  const days = new Map<string, Map<string, StorePoint>>();
  for (const row of rows) {
    const date = row.date;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      day(new Date(date)) !== date
    )
      throw new StoreProviderError('REPORT_DATE_INVALID');
    const apple = options.format.startsWith('apple');
    if (row[apple ? 'app apple identifier' : 'package name'] !== options.appId)
      throw new StoreProviderError('REPORT_APP_MISMATCH');
    if (date < options.range.from || date > options.range.to) continue;
    const dimension = JSON.stringify(
      apple
        ? {
            country: row.territory || 'unknown',
            source: row['source type'] || 'unknown',
            version: row['app version'] || 'unknown',
            device: row.device || 'unknown',
            osVersion: row['platform version'] || 'unknown',
            ...(options.format === 'apple_engagement'
              ? {
                  event: row.event || '',
                  action: row['engagement type'] || '',
                  page: row['page type'] || '',
                }
              : {}),
          }
        : {
            country: row.country || row['country/region'] || 'unknown',
            ...(row['app version code'] !== undefined
              ? { version: row['app version code'] }
              : {}),
            ...(row.device !== undefined ? { device: row.device } : {}),
            ...(row['android os version'] !== undefined
              ? { osVersion: row['android os version'] }
              : {}),
          },
    );
    if (dimension.length > 2000)
      throw new StoreProviderError('REPORT_DIMENSION_TOO_LARGE');
    if (!days.has(date)) days.set(date, new Map());
    const add = (metric: string, field: string) => {
      if (!(field in row))
        throw new StoreProviderError('REPORT_SCHEMA_UNSUPPORTED');
      const value = count(row[field]);
      if (value === null) return;
      const key = `${metric}:${dimension}`;
      const previous = days.get(date)!.get(key)?.value ?? 0;
      if (!Number.isSafeInteger(previous + value))
        throw new StoreProviderError('REPORT_NUMBER_INVALID');
      days
        .get(date)!
        .set(key, { date, dimension, metric, value: previous + value });
    };
    switch (options.format) {
      case 'google_installs':
        add('google.device_installs', 'daily device installs');
        add('google.user_installs', 'daily user installs');
        add('google.device_uninstalls', 'daily device uninstalls');
        if ('current device installs' in row)
          add('google.installed_base', 'current device installs');
        if ('installs on active devices' in row)
          add('google.active_installed_devices', 'installs on active devices');
        break;
      case 'google_crashes':
        add('google.crashes', 'daily crashes');
        add('google.anrs', 'daily anrs');
        break;
      case 'google_acquisitions':
        add('google.store_visitors', 'store listing visitors');
        add('google.store_acquisitions', 'store listing acquisitions');
        break;
      case 'apple_downloads': {
        const metric: Record<string, string> = {
          'First-time Download': 'apple.first_time_downloads',
          Redownload: 'apple.redownloads',
          'Manual update': 'apple.updates',
          'Auto-update': 'apple.updates',
        };
        if (metric[row['download type']])
          add(metric[row['download type']], 'counts');
        break;
      }
      case 'apple_engagement':
        add('apple.engagement_events', 'counts');
        if (row.event === 'Impression') add('apple.impressions', 'counts');
        if (row.event === 'Page view' && row['page type'] === 'Product page')
          add('apple.product_page_views', 'counts');
        break;
      case 'apple_crashes':
        add('apple.crashes', 'crashes');
        break;
      case 'apple_installs':
        if (row.event === 'Install') add('apple.installations', 'counts');
        else if (row.event === 'Delete') add('apple.deletions', 'counts');
        break;
      case 'apple_sessions':
        add('apple.sessions', 'sessions');
        add('apple.session_seconds', 'total session duration');
        break;
    }
  }
  return [...days].map(([date, points]) => ({
    dataset: options.dataset,
    date,
    revision: options.revision,
    points: [...points.values()],
  }));
}
