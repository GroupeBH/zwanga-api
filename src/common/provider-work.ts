import { ServiceUnavailableException } from '@nestjs/common';

/** Bounds retained in-flight requests; identical callers share work, not a stale result cache. */
export class ProviderSingleFlight {
  private readonly pending = new Map<string, Promise<any>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 64) return Promise.reject(new ServiceUnavailableException('Service temporairement occupé. Réessayez.'));
    const promise = Promise.resolve().then(work).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}

/** Abort actual provider I/O on deadline, also covering time spent reading the cache. */
export async function withProviderDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('PROVIDER_BUDGET_EXHAUSTED');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('PROVIDER_BUDGET_EXHAUSTED')); }, ms);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
