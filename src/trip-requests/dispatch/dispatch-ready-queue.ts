type Lane = 'recovery' | 'ready';
type Job = { id: string; at: number; done: Promise<void>; resolve: () => void };

/** Local acceleration only. Every job retains its Redis deadline or SQL recovery
 * row. A full queue/restart must never drop the durable scheduling obligation. */
export class DispatchReadyQueue {
  private readonly lanes: Record<Lane, Map<string, Job>> = { recovery: new Map(), ready: new Map() };
  private readonly running = new Map<string, Promise<void>>();
  private next: Lane = 'recovery';
  private draining = false;
  private stopped = false;
  private peak = 0;
  private overflow = 0;
  private completed = 0;
  private maxWaitMs = 0;
  constructor(private readonly run: (id: string) => Promise<unknown>,
    private readonly available: () => boolean, private readonly settled: () => void,
    private readonly capacity = 128) {}
  get size() { return this.lanes.ready.size + this.lanes.recovery.size; }
  get readySize() { return this.lanes.ready.size; }
  enqueue(id: string, lane: Lane = 'ready'): Promise<void> | null {
    const existing = this.running.get(id) ?? this.lanes.ready.get(id)?.done ?? this.lanes.recovery.get(id)?.done;
    if (existing) return existing;
    if (this.stopped || this.size >= this.capacity) { this.overflow++; return null; }
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    this.lanes[lane].set(id, { id, at: performance.now(), done, resolve });
    this.peak = Math.max(this.peak, this.size);
    this.wake();
    return done;
  }
  wake() {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      while (this.size && this.running.size < 3 && this.available()) {
        const lane = this.lanes[this.next].size ? this.next : this.next === 'ready' ? 'recovery' : 'ready';
        const job = this.lanes[lane].values().next().value as Job;
        this.lanes[lane].delete(job.id);
        this.next = lane === 'ready' ? 'recovery' : 'ready';
        this.maxWaitMs = Math.max(this.maxWaitMs, performance.now() - job.at);
        // Invoke synchronously: advance reserves its shared slot before yielding.
        // Store the promise first so reentrant hints coalesce too.
        this.running.set(job.id, job.done);
        let work: Promise<unknown>;
        try { work = this.run(job.id); } catch (error) { work = Promise.reject(error); }
        void work.catch(() => undefined).finally(() => {
          this.running.delete(job.id); this.completed++; job.resolve();
          this.wake();
          if (!this.stopped) this.settled();
        });
      }
    } finally { this.draining = false; }
  }
  snapshot() {
    return { waiting: this.size, readyWaiting: this.readySize, running: this.running.size,
      peakWaiting: this.peak, overflow: this.overflow, completed: this.completed, maxWaitMs: this.maxWaitMs };
  }
  async stop() {
    this.stopped = true;
    for (const lane of Object.values(this.lanes)) {
      for (const job of lane.values()) job.resolve();
      lane.clear();
    }
    await Promise.all(this.running.values());
  }
}
