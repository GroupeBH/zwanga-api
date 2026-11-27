import { ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

type Ticket = { at: number; start: () => void; reject: () => void; timer?: NodeJS.Timeout };

/** Local admission BEFORE the first SQL read. This is not an ownership lock:
 * PostgreSQL still arbitrates competing replicas and rechecks every decision.
 * Release after the transaction, before Redis/notifications/next-wave work.
 * Never time out or retry a callback that has started (its commit may succeed).
 */
export class DispatchResponseAdmission {
  private active = 0;
  private peakActive = 0;
  private peakWaiting = 0;
  private completed = 0;
  private failed = 0;
  private rejected = { full: 0, expired: 0 };
  private wait = { count: 0, totalMs: 0, maxMs: 0 };
  private readonly queue: Ticket[] = [];

  constructor(readonly capacity: number, private readonly maxWaiting = 32, private readonly maxWaitMs = 750,
    private readonly now = () => performance.now(),
    private readonly busyCode: 'DISPATCH_RESPONSE_BUSY' | 'NOTIFICATION_RECEIPT_BUSY' = 'DISPATCH_RESPONSE_BUSY') {
    if (![capacity, maxWaiting, maxWaitMs].every(n => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid dispatch response admission capacity');
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const at = this.now();
    // drain() may run in another request's context; retain this request's traces.
    const execute = AsyncLocalStorage.bind(work);
    return new Promise<T>((resolve, reject) => {
      const observeWait = () => {
        const ms = this.now() - at;
        this.wait.count++; this.wait.totalMs += ms; this.wait.maxMs = Math.max(this.wait.maxMs, ms);
      };
      const refuse = (reason: 'full' | 'expired') => {
        this.rejected[reason]++; observeWait();
        reject(new ServiceUnavailableException({ code: this.busyCode,
          message: this.busyCode === 'NOTIFICATION_RECEIPT_BUSY'
            ? 'La réception ne peut pas être confirmée pour le moment. Réessayez.'
            : 'Le service est momentanément occupé. Réessayez votre réponse.', retryable: true }));
      };
      const ticket: Ticket = { at, reject: () => refuse('expired'), start: () => {
        if (ticket.timer) clearTimeout(ticket.timer);
        // A delayed timer must not allow stale queued work to start after a stall.
        if (this.now() - at >= this.maxWaitMs) { ticket.reject(); return; }
        observeWait(); this.active++; this.peakActive = Math.max(this.peakActive, this.active);
        const finish = () => { this.completed++; this.active--; this.drain(); };
        Promise.resolve().then(execute).then(value => { finish(); resolve(value); }, error => {
          this.failed++; finish(); reject(error);
        });
      } };
      if (this.active < this.capacity && !this.queue.length) { ticket.start(); return; }
      if (this.queue.length >= this.maxWaiting) { refuse('full'); return; }
      this.queue.push(ticket); this.peakWaiting = Math.max(this.peakWaiting, this.queue.length);
      ticket.timer = setTimeout(() => {
        const index = this.queue.indexOf(ticket);
        if (index < 0) return;
        this.queue.splice(index, 1); ticket.reject();
      }, this.maxWaitMs);
    });
  }

  private drain() {
    while (this.active < this.capacity && this.queue.length) this.queue.shift()!.start();
  }

  snapshot() {
    return { capacity: this.capacity, active: this.active, peakActive: this.peakActive,
      waiting: this.queue.length, peakWaiting: this.peakWaiting, maxWaiting: this.maxWaiting, maxWaitMs: this.maxWaitMs,
      oldestWaitingMs: this.queue.length ? this.now() - this.queue[0].at : 0,
      completed: this.completed, failed: this.failed, rejected: { ...this.rejected }, wait: { ...this.wait } };
  }
}

type Source = { options?: { extra?: { max?: number }; poolSize?: number } };
const budgets = new WeakMap<Source, DispatchResponseAdmission>();
export function dispatchResponseAdmission(db: Source): DispatchResponseAdmission {
  let budget = budgets.get(db);
  if (!budget) {
    const size = Number(db.options?.extra?.max ?? db.options?.poolSize ?? 10);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid SQL pool capacity');
    // At most two competing response transactions per API, not per controller.
    budget = new DispatchResponseAdmission(Math.max(1, Math.min(2, Math.floor(size * .2))));
    budgets.set(db, budget);
  }
  return budget;
}
