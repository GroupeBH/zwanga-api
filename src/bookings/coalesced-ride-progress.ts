type Result = { tripId: string; events: unknown[] };
type Pending<T> = {
  operation: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

/** One running evaluation and at most one queued re-read per trip. */
export class CoalescedRideProgress<T extends Result> {
  private readonly trips = new Map<string, { pending?: Pending<T> }>();

  run(tripId: string, operation: () => Promise<T>): Promise<T> {
    const active = this.trips.get(tripId);
    if (active) {
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
    const state: { pending?: Pending<T> } = {};
    this.trips.set(tripId, state);
    return this.execute(tripId, state, operation);
  }

  private async execute(
    tripId: string,
    state: { pending?: Pending<T> },
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } finally {
      const next = state.pending;
      if (next) {
        state.pending = undefined;
        void this.execute(tripId, state, next.operation).then(
          next.resolve,
          next.reject,
        );
      } else this.trips.delete(tripId);
    }
  }
}
