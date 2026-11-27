export type NotificationPreparationLane = 'urgent' | 'standard' | 'realtime';

/** SQL preparation only, never provider HTTP. Callers already own bounded
 * outbox workers; waiting work retains its durable claim and original deadline.
 * Separate lanes prevent slow push preparation from starving realtime. */
export class NotificationPreparation {
  private readonly lanes = {
    urgent: { active: 0, capacity: 2, waiting: [] as Array<() => void> },
    standard: { active: 0, capacity: 1, waiting: [] as Array<() => void> },
    realtime: { active: 0, capacity: 2, waiting: [] as Array<() => void> },
  };

  async run<T>(name: NotificationPreparationLane, work: () => Promise<T>): Promise<T> {
    const lane = this.lanes[name];
    if (lane.active >= lane.capacity) {
      await new Promise<void>(resolve => lane.waiting.push(resolve));
    } else {
      lane.active++;
    }
    try {
      return await work();
    } finally {
      const next = lane.waiting.shift();
      if (next) next(); // Transfer the occupied slot, preventing queue jumping.
      else lane.active--;
    }
  }
}
