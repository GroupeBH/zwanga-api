import { FreshReadBatch } from './fresh-read-batch';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('fresh bounded read batching (not a cache)', () => {
  it('groups a burst in order and bounds each statement without waiting for a full batch', async () => {
    const read = jest.fn(async (ids: number[]) => ids.map(id => id * 2));
    const batch = new FreshReadBatch(read, 4);
    const calls = Array.from({ length: 11 }, (_, id) => batch.load(id));
    expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([4, 4]);
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 11 }, (_, id) => id * 2));
    expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([4, 4, 3]);
  });

  it('never joins an already submitted query or reuses its results', async () => {
    const completions: Array<(rows: number[]) => void> = [];
    const read = jest.fn((_ids: string[]) => new Promise<number[]>(resolve => completions.push(resolve)));
    const batch = new FreshReadBatch(read);
    const first = batch.load('same');
    await turn();
    const second = batch.load('same');
    await turn();
    expect(read).toHaveBeenCalledTimes(2);
    completions[1]([2]); completions[0]([1]);
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    const third = batch.load('same');
    await turn(); completions[2]([3]);
    expect(await third).toBe(3);
  });

  it('rejects the whole failed batch, then allows a fresh retry', async () => {
    const error = new Error('database unavailable');
    const read = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([7]);
    const batch = new FreshReadBatch(read);
    const results = await Promise.allSettled([batch.load(1), batch.load(2)]);
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(await batch.load(1)).toBe(7);
  });

  it('propagates a synchronous read failure without leaving pending promises', async () => {
    const batch = new FreshReadBatch(() => { throw new Error('query failed'); });
    await expect(batch.load(1)).rejects.toThrow('query failed');
  });

  it('fails closed on mismatched result counts', async () => {
    const batch = new FreshReadBatch(async () => []);
    await expect(batch.load(1)).rejects.toThrow('result mismatch');
  });

  it('isolates different repository-scoped batches', async () => {
    const first = new FreshReadBatch(async () => ['one']);
    const second = new FreshReadBatch(async () => ['two']);
    expect(await Promise.all([first.load('same'), second.load('same')])).toEqual(['one', 'two']);
  });

  it.each([0, -1, 1.5, Infinity, NaN])('rejects an invalid bound %s', limit => {
    expect(() => new FreshReadBatch(async () => [], limit)).toThrow('Invalid');
  });
});
