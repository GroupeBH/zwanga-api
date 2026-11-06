import { StorePartition, StoreProviderError } from './store.types';
import { parseReport } from './store.reports';

/** Units deliberately retain product type; refunds never masquerade as negative installations. */
export function appleSalesPartition(
  text: string,
  appId: string,
  date: string,
  revision: string,
): StorePartition {
  const rows = parseReport(text, '\t', 'begin date');
  const points = new Map<
    string,
    { date: string; dimension: string; metric: string; value: number }
  >();
  const us =
    date.slice(5, 7) + '/' + date.slice(8, 10) + '/' + date.slice(0, 4);
  for (const row of rows) {
    if (
      ![
        'apple identifier',
        'units',
        'product type identifier',
        'country code',
        'end date',
      ].every((k) => k in row)
    )
      throw new StoreProviderError('SALES_REPORT_SCHEMA_UNSUPPORTED');
    if (row['apple identifier'] !== appId) continue;
    if (
      row['begin date'] !== us ||
      row['end date'] !== us ||
      !/^-?\d+(\.\d{1,2})?$/.test(row.units)
    )
      throw new StoreProviderError('SALES_REPORT_ROW_INVALID');
    const units = Number(row.units);
    if (!Number.isSafeInteger(Math.round(units * 100)))
      throw new StoreProviderError('SALES_REPORT_VALUE_INVALID');
    const metric = units < 0 ? 'apple.sales_return_units' : 'apple.sales_units';
    const dimension = JSON.stringify({
      country: row['country code'],
      version: row.version ?? '',
      productType: row['product type identifier'],
    });
    const key = metric + dimension,
      existing = points.get(key);
    const value = (existing?.value ?? 0) + Math.abs(units);
    if (!Number.isSafeInteger(Math.round(value * 100)))
      throw new StoreProviderError('SALES_REPORT_VALUE_INVALID');
    points.set(key, { date, dimension, metric, value });
  }
  return {
    dataset: 'sales_summary',
    date,
    revision,
    points: [...points.values()],
  };
}
