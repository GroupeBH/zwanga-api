import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AppleStoreProvider } from './apple-store.provider';
import { StoreAuth } from './store.auth';
import { StoreConfig } from './store.config';
import type { StoreBatch } from './store.types';

const API = 'https://api.appstoreconnect.apple.com/v1';
const range = { from: '2026-01-01', to: '2026-01-03' };
const downloads = Buffer.from(
  'Date\tApp Apple Identifier\tDownload Type\tCounts\n' +
    '2026-01-01\t123\tFirst-time Download\t12\n' +
    '2026-01-01\t123\tRedownload\t5\n' +
    '2026-01-01\t123\tAuto-update\t3\n',
);
const installations = Buffer.from(
  'Date\tApp Apple Identifier\tEvent\tCounts\n' +
    '2026-01-01\t123\tInstall\t8\n' +
    '2026-01-01\t123\tDelete\t2\n',
);

function setup(names: string[], bytes = downloads) {
  const http = {
    api: jest
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 'request' }] })
      .mockResolvedValueOnce({
        data: names.map((name, index) => ({
          id: `report-${index}`,
          attributes: { name },
        })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'instance',
            attributes: { processingDate: '2026-01-03' },
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'segment',
            attributes: {
              url: 'https://reports.apple.com/test-report',
              sizeInBytes: bytes.length,
              checksum: createHash('sha256').update(bytes).digest('hex'),
            },
          },
        ],
      }),
    report: jest.fn().mockResolvedValue(bytes),
  };
  const auth = { apple: jest.fn().mockReturnValue('test-token') };
  const provider = new AppleStoreProvider(
    auth as unknown as StoreAuth,
    http,
    new StoreConfig(new ConfigService({})),
  );
  const signal = new AbortController().signal;
  const run = async (imported = new Set<string>()) => {
    const batches: StoreBatch[] = [];
    for await (const batch of provider.sync(
      '123',
      'reports',
      range,
      signal,
      imported,
    )) {
      batches.push(batch);
    }
    return batches;
  };
  return { http, signal, run };
}

describe('Apple Analytics report names (mocked API, no external calls)', () => {
  it.each([
    'App Downloads Standard',
    'App Downloads',
    'App Store Downloads Standard',
    'App Store Downloads',
  ])('imports %s into the existing downloads dataset', async (name) => {
    const { http, signal, run } = setup([name]);
    const batches = await run();
    expect(batches).toHaveLength(1);
    expect(batches[0].partitions).toEqual([
      {
        dataset: 'App Store Downloads',
        date: '2026-01-01',
        revision: '2026-01-03',
        points: [
          expect.objectContaining({
            metric: 'apple.first_time_downloads',
            value: 12,
          }),
          expect.objectContaining({ metric: 'apple.redownloads', value: 5 }),
          expect.objectContaining({ metric: 'apple.updates', value: 3 }),
        ],
      },
    ]);
    expect(batches[0].items?.[0].content).toMatchObject({
      name: 'App Store Downloads',
      sourceName: name,
      state: 'available',
    });
    expect(http.api).toHaveBeenNthCalledWith(
      3,
      `${API}/analyticsReports/report-0/instances`,
      'test-token',
      { signal, params: { limit: 200, 'filter[granularity]': 'DAILY' } },
    );
    expect(http.api).toHaveBeenCalledTimes(4);
    expect(http.report).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'App Store Installation and Deletion Standard',
      'App Store Installations and Deletions',
    ],
    [
      'App Store Installation and Deletion',
      'App Store Installations and Deletions',
    ],
    [
      'App Store Installations and Deletions Standard',
      'App Store Installations and Deletions',
    ],
    [
      'App Store Installations and Deletions',
      'App Store Installations and Deletions',
    ],
    [
      'App Installations and Deletions Standard',
      'App Installations and Deletions',
    ],
    ['App Installations and Deletions', 'App Installations and Deletions'],
  ])(
    'imports %s without changing its compatible dataset',
    async (name, dataset) => {
      const { run } = setup([name], installations);
      const batches = await run();
      expect(batches).toHaveLength(1);
      expect(batches[0].partitions).toEqual([
        {
          dataset,
          date: '2026-01-01',
          revision: '2026-01-03',
          points: [
            expect.objectContaining({
              metric: 'apple.installations',
              value: 8,
            }),
            expect.objectContaining({ metric: 'apple.deletions', value: 2 }),
          ],
        },
      ]);
      expect(batches[0].items?.[0].content).toMatchObject({
        name: dataset,
        sourceName: name,
      });
    },
  );

  it('does not combine Detailed reports with their Standard counterpart', async () => {
    const { http, run } = setup([
      'App Downloads Detailed',
      'App Downloads Standard',
      'App Store Downloads Detailed',
      'App Store Installation and Deletion Detailed',
      'App Store Installations and Deletions Detailed',
      'Unsupported report',
    ]);
    const batches = await run();
    expect(batches).toHaveLength(1);
    expect(batches[0].partitions?.[0].points[0].value).toBe(12);
    expect(http.api).toHaveBeenNthCalledWith(
      3,
      `${API}/analyticsReports/report-1/instances`,
      'test-token',
      expect.anything(),
    );
    expect(http.api).toHaveBeenCalledTimes(4);
    expect(http.report).toHaveBeenCalledTimes(1);
  });

  it('keeps Detailed-only data unavailable instead of importing it as Standard', async () => {
    const { http, run } = setup([
      'App Downloads Detailed',
      'App Store Installation and Deletion Detailed',
    ]);
    await expect(run()).rejects.toThrow('REPORTS_NOT_YET_AVAILABLE');
    expect(http.api).toHaveBeenCalledTimes(2);
    expect(http.report).not.toHaveBeenCalled();
  });

  it('keeps a recognized report without daily instances unavailable, not zero', async () => {
    const { http, run } = setup(['App Downloads Standard']);
    http.api.mockReset();
    http.api
      .mockResolvedValueOnce({ data: [{ id: 'request' }] })
      .mockResolvedValueOnce({
        data: [
          { id: 'report', attributes: { name: 'App Downloads Standard' } },
        ],
      })
      .mockResolvedValueOnce({ data: [] });
    await expect(run()).rejects.toThrow('REPORTS_NOT_YET_AVAILABLE');
    expect(http.api).toHaveBeenCalledTimes(3);
    expect(http.report).not.toHaveBeenCalled();
  });

  it('preserves instance deduplication for the newly recognized names', async () => {
    const { http, run } = setup(['App Downloads Standard']);
    await expect(run(new Set(['instance:instance']))).resolves.toEqual([]);
    expect(http.api).toHaveBeenCalledTimes(3);
    expect(http.report).not.toHaveBeenCalled();
  });

  it('still rejects content that fails checksum validation', async () => {
    const { http, run } = setup(['App Downloads Standard']);
    http.report.mockResolvedValue(Buffer.alloc(downloads.length, 65));
    await expect(run()).rejects.toThrow('REPORT_CHECKSUM_MISMATCH');
  });
});
