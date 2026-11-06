import { streamExport } from './streaming-export';
import { buildTripsSpreadsheet } from './admin-spreadsheets';
import type { SpreadsheetDownload } from './spreadsheet';

async function buffer(file: SpreadsheetDownload) {
  if ('buffer' in file) return file.buffer.toString('utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
describe('bounded admin spreadsheet downloads', () => {
  const rows = Array.from({ length: 1201 }, (_, i) => ({
    id: `row-${i}`,
    departureLocation: '<bad>&"',
  }));
  it('streams every row exactly once with one workbook/header and escaped data', async () => {
    const load = jest.fn(async (offset, limit) =>
      rows.slice(offset, offset + limit),
    );
    const file = await streamExport(load, buildTripsSpreadsheet);
    expect(load).toHaveBeenCalledTimes(1);
    const xml = await buffer(file);
    expect(xml.match(/<Workbook /g) || []).toHaveLength(1);
    expect(xml.match(/<Row>/g) || []).toHaveLength(1202);
    expect(xml).toContain('&lt;bad&gt;&amp;&quot;');
    expect(xml).toContain('row-1200');
    expect(load.mock.calls).toEqual([
      [0, 500],
      [500, 500],
      [1000, 500],
    ]);
  });
  it('keeps small exports byte-compatible', async () => {
    const expected = buildTripsSpreadsheet(rows.slice(0, 1));
    const actual = await streamExport(
      async () => rows.slice(0, 1),
      buildTripsSpreadsheet,
    );
    expect('buffer' in actual && actual.buffer.equals(expected.buffer)).toBe(
      true,
    );
  });
  it('releases an unconsumed timed-out download without an uncaught stream error', async () => {
    jest.useFakeTimers();
    try {
      const file = await streamExport(async () => rows.slice(0, 500), buildTripsSpreadsheet);
      if (!('stream' in file)) throw new Error('expected stream');
      await jest.advanceTimersByTimeAsync(300_001);
      expect(file.stream.destroyed).toBe(true);
      await expect(streamExport(async () => [], buildTripsSpreadsheet)).resolves.toBeDefined();
    } finally { jest.useRealTimers(); }
  });
  it('stops reading pages after a client disconnect', async () => {
    const load = jest.fn(async () => rows.slice(0, 500));
    const file = await streamExport(load, buildTripsSpreadsheet);
    if (!('stream' in file)) throw new Error('expected stream');
    await new Promise<void>((resolve) => {
      file.stream.once('close', resolve);
      file.stream.destroy();
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('propagates a mid-download SQL failure instead of emitting a successful truncated file', async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(rows.slice(0, 500))
      .mockRejectedValue(new Error('SQL failed'));
    const file = await streamExport(load, buildTripsSpreadsheet);
    await expect(buffer(file)).rejects.toThrow('SQL failed');
  });
  it('bounds simultaneous exports and releases permits when the stream is closed', async () => {
    const first = await streamExport(
      async () => rows.slice(0, 500),
      buildTripsSpreadsheet,
    );
    const second = await streamExport(
      async () => rows.slice(0, 500),
      buildTripsSpreadsheet,
    );
    try {
      await expect(
        streamExport(async () => [], buildTripsSpreadsheet),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await Promise.all(
        [first, second].map(
          (file) =>
            new Promise<void>((resolve) => {
              if (!('stream' in file)) return resolve();
              file.stream.once('close', resolve);
              file.stream.destroy();
            }),
        ),
      );
    }
    await expect(
      streamExport(async () => [], buildTripsSpreadsheet),
    ).resolves.toBeDefined();
  });
});
