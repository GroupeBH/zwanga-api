/** Combine simultaneous reads, never cache results or join an in-flight read.
 * A single event-loop turn is the only batching delay. Bound every SQL batch;
 * caller admission (WebSocket/worker limits) still bounds total work in flight.
 * Keep one instance per repository/transaction scope, not per database name.
 */
export class FreshReadBatch<Key, Value> {
  private pending: Array<{ key: Key; resolve: (value: Value) => void; reject: (error: unknown) => void }> = [];
  private scheduled?: NodeJS.Immediate;

  constructor(private readonly read: (keys: Key[]) => Promise<Value[]>, private readonly limit = 32) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid fresh read batch limit');
  }

  load(key: Key): Promise<Value> {
    return new Promise((resolve, reject) => {
      this.pending.push({ key, resolve, reject });
      if (this.pending.length >= this.limit) this.flush();
      else if (!this.scheduled) this.scheduled = setImmediate(() => this.flush());
    });
  }

  private flush(): void {
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    const batch = this.pending;
    this.pending = []; // New calls must get a new database snapshot, even during SQL I/O.
    if (!batch.length) return;
    void this.execute(batch);
  }

  private async execute(batch: typeof this.pending): Promise<void> {
    try {
      const values = await this.read(batch.map(item => item.key));
      if (values.length !== batch.length) throw new Error('Fresh read batch result mismatch');
      batch.forEach((item, index) => item.resolve(values[index]));
    } catch (error) {
      batch.forEach(item => item.reject(error)); // Never turn a DB failure into missing/authorized state.
    }
  }
}
