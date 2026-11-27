import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { WsWorkInterceptor } from './ws-work.interceptor';

describe('WebSocket work slot lifecycle', () => {
  const context = { switchToWs: () => ({ getClient: () => 'socket' }) } as any;
  const flush = () => new Promise(resolve => setImmediate(resolve));

  it('releases an admission that finishes after cancellation without starting the handler', async () => {
    let admitted!: (release: () => void) => void;
    const begin = jest.fn(() => new Promise<() => void>(resolve => { admitted = resolve; }));
    const release = jest.fn(), next = { handle: jest.fn(() => of('ok')) };
    const subscription = new WsWorkInterceptor({ begin } as any).intercept(context, next).subscribe();
    subscription.unsubscribe(); admitted(release); await flush();
    expect(release).toHaveBeenCalledTimes(1); expect(next.handle).not.toHaveBeenCalled();
  });

  it('releases once on completion, error and cancellation after admission', async () => {
    for (const outcome of ['complete', 'error', 'cancel']) {
      const release = jest.fn(), subject = new Subject();
      const interceptor = new WsWorkInterceptor({ begin: jest.fn().mockResolvedValue(release) } as any);
      const stream = interceptor.intercept(context, { handle: () => outcome === 'complete'
        ? of('ok') : outcome === 'error' ? throwError(() => new Error('failure')) : subject });
      if (outcome === 'cancel') { const sub = stream.subscribe(); await flush(); sub.unsubscribe(); }
      else if (outcome === 'error') await expect(firstValueFrom(stream)).rejects.toThrow('failure');
      else expect(await firstValueFrom(stream)).toBe('ok');
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it('does not share cleanup state across subscriptions', async () => {
    const a = jest.fn(), b = jest.fn();
    const interceptor = new WsWorkInterceptor({ begin: jest.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b) } as any);
    const stream = interceptor.intercept(context, { handle: () => of('ok') });
    await firstValueFrom(stream); await firstValueFrom(stream);
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not run the handler when admission fails', async () => {
    const next = { handle: jest.fn() };
    const interceptor = new WsWorkInterceptor({ begin: jest.fn().mockRejectedValue(new Error('quota')) } as any);
    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toThrow('quota');
    expect(next.handle).not.toHaveBeenCalled();
  });
});
