import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';

export type SqlLane = 'progress' | 'delivery' | 'dispatch' | 'maintenance';
type Source = { connection?: Source; options?: { extra?: { max?: number }; poolSize?: number };
  queryRunner?: { isTransactionActive?: boolean } };
const bounds = [1, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const order: SqlLane[] = ['progress', 'delivery', 'dispatch', 'progress', 'delivery', 'maintenance'];
const lanes: SqlLane[] = ['progress', 'delivery', 'dispatch', 'maintenance'];
const histogram = () => ({ count: 0, sumMs: 0, maxMs: 0, buckets: bounds.map(() => 0), overflow: 0 });
type Histogram = ReturnType<typeof histogram>;
function observe(h: Histogram, ms: number) {
  h.count++; h.sumMs += ms; h.maxMs = Math.max(h.maxMs, ms);
  const index = bounds.findIndex(bound => ms <= bound);
  if (index < 0) h.overflow++; else h.buckets[index]++;
}
function summary(h: Histogram) {
  let count = 0;
  const p95 = bounds.find((_, index) => (count += h.buckets[index]) >= Math.ceil(h.count * .95));
  return { count: h.count, meanMs: h.count ? h.sumMs / h.count : 0, maxMs: h.maxMs,
    p95UpperBoundMs: h.count ? p95 ?? null : null };
}
export class SqlAdmissionDeferred extends Error {
  readonly code = 'SQL_BACKGROUND_ADMISSION_DEFERRED';
  constructor() { super('Background SQL deferred before connection acquisition'); }
}
type Ticket = { queuedAt: number; start: () => void; reject: () => void; timer?: NodeJS.Timeout };

/** Shared per DataSource, not per module. Foreground GPS and receipts keep the
 * existing pool path; responses have separate admission, background uses at most 60%.
 * This is headroom, not a hard reservation against other unclassified SQL.
 * Acquire BEFORE a query/transaction, never across HTTP, Redis or business hooks.
 * Only queued work may time out: an executing commit is never raced/cancelled.
 */
export class BackgroundSqlBudget {
  private active = 0;
  private cursor = 0;
  private peakWaiting = 0;
  private lastWarningAt = -Infinity;
  private readonly queues = Object.fromEntries(lanes.map(lane => [lane, [] as Ticket[]])) as Record<SqlLane, Ticket[]>;
  private readonly metrics = Object.fromEntries(lanes.map(lane => [lane, {
    active: 0, completed: 0, failed: 0, deferred: 0, wait: histogram(), run: histogram(), total: histogram(),
  }])) as Record<SqlLane, { active: number; completed: number; failed: number; deferred: number;
    wait: Histogram; run: Histogram; total: Histogram }>;
  constructor(readonly capacity: number, private readonly maxWaiting = 128, private readonly maxWaitMs = 2000,
    private readonly now = () => performance.now()) {
    if (![capacity, maxWaiting, maxWaitMs].every(value => Number.isSafeInteger(value) && value > 0))
      throw new Error('Invalid SQL admission budget');
  }
  private get waiting() { return lanes.reduce((sum, lane) => sum + this.queues[lane].length, 0); }
  run<T>(lane: SqlLane, work: () => Promise<T>): Promise<T> {
    const queuedAt = this.now(), metric = this.metrics[lane];
    // A slot may be released by a different lane/request; do not inherit its trace.
    const execute = AsyncLocalStorage.bind(work);
    return new Promise<T>((resolve, reject) => {
      const ticket: Ticket = { queuedAt,
        reject: () => {
          metric.deferred++;
          observe(metric.wait, this.now() - queuedAt);
          observe(metric.total, this.now() - queuedAt);
          reject(new SqlAdmissionDeferred());
          this.warnIfSlow(true);
        },
        start: () => {
          if (ticket.timer) clearTimeout(ticket.timer);
          // The event loop can delay the timeout callback. A connection release
          // must not start expired queued work before that callback gets its turn.
          if (ticket.timer && this.now() - queuedAt >= this.maxWaitMs) { ticket.reject(); return; }
          this.active++; metric.active++;
          const startedAt = this.now(); observe(metric.wait, startedAt - queuedAt);
          // Defer the callback, not acquisition. Synchronous throws release the slot too.
          const finish = () => {
            metric.completed++; metric.active--; this.active--;
            observe(metric.run, this.now() - startedAt);
            observe(metric.total, this.now() - queuedAt);
            this.drain();
            this.warnIfSlow(startedAt - queuedAt >= 250);
          };
          Promise.resolve().then(execute).then(value => { finish(); resolve(value); }, error => {
            metric.failed++; finish(); reject(error);
          });
        },
      };
      if (this.active < this.capacity && !this.waiting) { ticket.start(); return; }
      if (this.waiting >= this.maxWaiting) { ticket.reject(); return; }
      this.queues[lane].push(ticket);
      this.peakWaiting = Math.max(this.peakWaiting, this.waiting);
      ticket.timer = setTimeout(() => {
        const index = this.queues[lane].indexOf(ticket);
        if (index < 0) return;
        this.queues[lane].splice(index, 1); ticket.reject();
      }, this.maxWaitMs);
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.capacity && this.waiting) {
      // Weighted round-robin, FIFO within each lane. Maintenance cannot starve.
      const lane = order[this.cursor++ % order.length];
      this.queues[lane].shift()?.start();
    }
    this.cursor %= order.length;
  }
  private warnIfSlow(slow: boolean) {
    const now = this.now();
    if (!slow || now - this.lastWarningAt < 30_000) return;
    this.lastWarningAt = now;
    // Bounded aggregate telemetry for production logs, never query text/IDs.
    Logger.warn('SQL_BACKGROUND_PRESSURE ' + JSON.stringify(this.snapshot()), 'BackgroundSqlBudget');
  }
  snapshot() {
    const now = this.now();
    return { capacity: this.capacity, active: this.active, waiting: this.waiting, peakWaiting: this.peakWaiting,
      maxWaitMs: this.maxWaitMs, maxWaiting: this.maxWaiting,
      oldestWaitingMs: Math.max(0, ...lanes.map(lane => this.queues[lane].length ? now - this.queues[lane][0].queuedAt : 0)),
      lanes: Object.fromEntries(lanes.map(lane => { const m = this.metrics[lane]; return [lane, {
        active: m.active, waiting: this.queues[lane].length, completed: m.completed, failed: m.failed,
        deferred: m.deferred, wait: summary(m.wait), run: summary(m.run), total: summary(m.total),
      }]; })),
    };
  }
}
const budgets = new WeakMap<object, BackgroundSqlBudget>();
export function backgroundSqlBudget(source: Source): BackgroundSqlBudget {
  const db = source.connection ?? source;
  let budget = budgets.get(db);
  if (!budget) {
    const size = Number(db.options?.extra?.max ?? db.options?.poolSize ?? 10);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid SQL pool capacity');
    budget = new BackgroundSqlBudget(Math.max(1, Math.floor(size * .6)));
    budgets.set(db, budget);
  }
  return budget;
}
export function backgroundSql<T>(source: Source, lane: SqlLane, work: () => Promise<T>): Promise<T> {
  // A runner-bound manager may already own a connection, even before BEGIN or
  // during after-commit hooks. Never queue while holding it or split its writes.
  if (source.queryRunner) return work();
  return backgroundSqlBudget(source).run(lane, work);
}
