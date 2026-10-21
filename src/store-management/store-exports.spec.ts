import { ConfigService } from '@nestjs/config';
import { PDFDocument } from 'pdf-lib';
import {
  storeCsv,
  storeSummaryPdf,
  StoreExportsService,
} from './store-exports.service';
import {
  metricAlert,
  storeMailConfigured,
  StoreAlertsService,
} from './store-alerts.service';
import { StoreConfig } from './store.config';
import { normalizeReport } from './store.reports';

describe('Store exports, missing-data semantics and optional delivery', () => {
  it('neutralizes CSV formulas without corrupting quotations or missing values', () => {
    const csv = storeCsv(
      ['a', 'b'],
      [
        ['=HYPERLINK("url")', null],
        ['  +SUM(A1:A2)', 'hello, "world"'],
      ],
    ).toString('utf8');
    expect(csv).toContain('"\'=HYPERLINK(""url"")"');
    expect(csv).toContain('"\'  +SUM(A1:A2)"');
    expect(csv).toContain('"hello, ""world"""');
    expect(csv).not.toContain('null');
  });
  it('creates readable paginated PDFs with metadata, without outbound access', async () => {
    const bytes = await storeSummaryPdf(
      'Rapport global',
      Array.from(
        { length: 100 },
        (_, i) =>
          `Jour ${i} : données disponibles et confidentialité. Source : rapport officiel.`,
      ),
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getTitle()).toBe('Rapport global');
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  });
  it('requires source-specific permission in addition to export permission', async () => {
    const stores = { dashboard: jest.fn(), records: jest.fn() };
    const exporter = new StoreExportsService(stores as any, {} as any);
    await expect(
      exporter.export('actor', ['store.reports.export'], {
        topic: 'reviews',
        format: 'csv',
      }),
    ).rejects.toThrow('Accès requis');
    expect(stores.records).not.toHaveBeenCalled();
  });
  it('never treats missing previous metrics as zero and uses explicit threshold semantics', () => {
    expect(metricAlert('metric_drop_percent', 25, 0, null)).toBe(false);
    expect(metricAlert('metric_drop_percent', 25, 1, 0)).toBe(false);
    expect(metricAlert('metric_drop_percent', 25, 75, 100)).toBe(true);
    expect(metricAlert('metric_above', 5, 5, null)).toBe(false);
    expect(metricAlert('metric_above', 5, 6, null)).toBe(true);
  });
  it('does no background DB or SMTP work when disabled', async () => {
    const config = new StoreConfig(new ConfigService({}));
    const repo = { db: { query: jest.fn(), getRepository: jest.fn() } };
    const alerts = new StoreAlertsService(config, repo as any, {} as any);
    expect(storeMailConfigured(config)).toBe(false);
    await alerts.evaluate();
    await alerts.deliverEmails();
    await alerts.retain();
    expect(repo.db.query).not.toHaveBeenCalled();
    expect(repo.db.getRepository).not.toHaveBeenCalled();
  });
  it('keeps installations, sessions and impressions separate from downloads and unique devices', () => {
    const options = {
      appId: '123',
      dataset: 'test',
      revision: '2026-01-03',
      range: { from: '2026-01-01', to: '2026-01-02' },
    };
    const row = {
      date: '2026-01-01',
      'app apple identifier': '123',
      event: 'Install',
      counts: '8',
      'unique devices': '4',
      'app version': '1.0',
    };
    const installs = normalizeReport([row], {
      ...options,
      format: 'apple_installs',
    });
    expect(installs[0].points[0]).toMatchObject({
      metric: 'apple.installations',
      value: 8,
    });
    expect(JSON.parse(installs[0].points[0].dimension).version).toBe('1.0');
    const sessions = normalizeReport(
      [{ ...row, sessions: '10', 'total session duration': '500' }],
      { ...options, format: 'apple_sessions' },
    );
    expect(sessions[0].points.map((p) => p.value)).toEqual([10, 500]);
    const impressions = normalizeReport([{ ...row, event: 'Impression' }], {
      ...options,
      format: 'apple_engagement',
    });
    expect(
      impressions[0].points.find((p) => p.metric === 'apple.impressions')
        ?.value,
    ).toBe(8);
    expect(impressions[0].points.some((p) => p.metric.includes('unique'))).toBe(
      false,
    );
  });
});
