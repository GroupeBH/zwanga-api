type Result = { tripId: string; events: unknown[] };
type Pending<T> = {
  operation: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

/** One running evaluation and at most one queued re-read per trip. */
export class CoalescedRideProgress<T extends Result> {
  private readonly trips = new Map<
    string,
    {
      pending?: Pending<T>;
      running: boolean;
      startedAt: number;
      idleTimer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly minimumIntervalMs = 0) {}

  run(tripId: string, operation: () => Promise<T>): Promise<T> {
    const active = this.trips.get(tripId);
    if (active?.running) {
      if (active.pending) {
        // Only the first caller of a batch broadcasts its events. All other
        // callers still await the same fresh evaluation, without duplicate pushes.
        return active.pending.promise.then((result) => ({
          ...result,
          events: [],
        }));
      }
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      active.pending = { operation, promise, resolve, reject };
      return promise;
    }
    const state = active ?? { running: false, startedAt: 0 };
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.running = true;
    this.trips.set(tripId, state);
    return this.execute(tripId, state, operation);
  }

  private async execute(
    tripId: string,
    state: {
      pending?: Pending<T>;
      running: boolean;
      startedAt: number;
      idleTimer?: ReturnType<typeof setTimeout>;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const delay = this.minimumIntervalMs - (Date.now() - state.startedAt);
      if (delay > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      state.startedAt = Date.now();
      return await operation();
    } finally {
      const next = state.pending;
      if (next) {
        state.pending = undefined;
        void this.execute(tripId, state, next.operation).then(
          next.resolve,
          next.reject,
        );
      } else {
        state.running = false;
        if (this.minimumIntervalMs > 0) {
          state.idleTimer = setTimeout(() => {
            if (this.trips.get(tripId) === state && !state.running)
              this.trips.delete(tripId);
          }, this.minimumIntervalMs);
          state.idleTimer.unref();
        } else this.trips.delete(tripId);
      }
    }
  }
}
