import { DispatchReadyQueue } from './dispatch-ready-queue';

describe('bounded local dispatch acceleration', () => {
  it('coalesces, bounds work and alternates ready requests with expiration recovery', async () => {
    let available = false;
    const started: string[] = [];
    const finish: (() => void)[] = [];
    const queue = new DispatchReadyQueue(id => {
      started.push(id); return new Promise<void>(resolve => { finish.push(resolve); });
    }, () => available, () => {}, 4);
    const a = queue.enqueue('a', 'recovery');
    expect(queue.enqueue('a')).toBe(a);
    const b = queue.enqueue('b', 'recovery');
    const c = queue.enqueue('c');
    const d = queue.enqueue('d');
    expect(queue.enqueue('overflow')).toBeNull();
    available = true; queue.wake();
    expect(started).toEqual(['a', 'c', 'b']);
    expect(queue.enqueue('a')).toBe(a);
    finish.shift()!(); await a;
    expect(started).toEqual(['a', 'c', 'b', 'd']);
    finish.splice(0).forEach(resolve => resolve());
    await Promise.all([b, c, d]);
    expect(queue.snapshot()).toMatchObject({ completed: 4, overflow: 1, waiting: 0, running: 0 });
    await queue.stop();
  });
  it('recovers its slots after an unexpected rejection and drains on shutdown', async () => {
    let available = false;
    const run = jest.fn().mockRejectedValue(new Error('temporary failure'));
    const queue = new DispatchReadyQueue(run, () => available, () => {});
    const a = queue.enqueue('a'); const b = queue.enqueue('b');
    available = true; queue.wake(); await Promise.all([a, b]);
    expect(queue.snapshot().running).toBe(0);
    available = false; const c = queue.enqueue('c');
    await queue.stop(); await c;
    expect(run).toHaveBeenCalledTimes(2);
    expect(queue.enqueue('d')).toBeNull();
  });
});
