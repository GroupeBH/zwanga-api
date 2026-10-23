import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DataSource, EntitySubscriberInterface, QueryRunner, TransactionCommitEvent, TransactionRollbackEvent, UpdateEvent } from 'typeorm';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { RideAlertRealtime } from './ride-alert-realtime.service';

type Change = { kind: 'request' | 'booking'; id: string; terminal: boolean };

/** Publish committed state only. A rollback (including a savepoint rollback)
 * drops hints; REST on reconnect/foreground remains the reconciliation path. */
@Injectable()
export class RideAlertChanges implements EntitySubscriberInterface, OnModuleDestroy {
  private pending = new WeakMap<QueryRunner, Map<string, Change>>();
  private ready = new Map<string, Change>();
  private draining = false;
  private stopped = false;
  private readonly logger = new Logger(RideAlertChanges.name);
  constructor(private readonly db: DataSource, private readonly realtime: RideAlertRealtime) {
    db.subscribers.push(this);
  }
  onModuleDestroy() {
    this.stopped = true; this.ready.clear();
    const i = this.db.subscribers.indexOf(this); if (i >= 0) this.db.subscribers.splice(i, 1);
  }

  async afterUpdate(event: UpdateEvent<TripRequest | Booking>) {
    const kind = event.metadata.target === TripRequest ? 'request' : event.metadata.target === Booking ? 'booking' : null;
    const id = event.entity?.id ?? event.databaseEntity?.id;
    const status = event.entity?.status;
    if (!kind || !id || !status || event.databaseEntity?.status === status) return;
    const change: Change = { kind, id, terminal: !['pending', 'offers_received'].includes(status) };
    if (!event.queryRunner.isTransactionActive) { this.enqueue(change); return; }
    const queue = this.pending.get(event.queryRunner) ?? new Map<string, Change>();
    if (queue.size < 200 || queue.has(`${kind}:${id}`)) queue.set(`${kind}:${id}`, change);
    this.pending.set(event.queryRunner, queue);
  }
  async afterTransactionCommit(event: TransactionCommitEvent) {
    if (event.queryRunner.isTransactionActive) return;
    const queue = this.pending.get(event.queryRunner);
    this.pending.delete(event.queryRunner);
    if (queue) for (const change of queue.values()) this.enqueue(change);
  }
  afterTransactionRollback(event: TransactionRollbackEvent) { this.pending.delete(event.queryRunner); }

  enqueue(change: Change) {
    if (this.stopped) return;
    const key = `${change.kind}:${change.id}`;
    if (this.ready.size < 200 || this.ready.has(key)) this.ready.set(key, change);
    if (!this.draining) { this.draining = true; void this.drain(); }
  }
  private async drain() {
    // Never await a second pool connection from a commit callback which still
    // holds its QueryRunner. One bounded worker coalesces bursts after commit.
    try {
      while (!this.stopped && this.ready.size) {
        const [key, change] = this.ready.entries().next().value!;
        this.ready.delete(key); await this.publish(change);
      }
    } finally { this.draining = false; }
  }

  async publish(change: Change) {
    try {
      // Identifiers are obtained from committed business relationships, never client rooms.
      const recipients: { userId: string }[] = change.kind === 'request'
        ? await this.db.query(`SELECT "passengerId" AS "userId" FROM trip_requests WHERE id = $1
            UNION SELECT "driverId" FROM trip_request_dispatch_offers WHERE "requestId" = $1
            UNION SELECT "driverId" FROM driver_offers WHERE "tripRequestId" = $1
            UNION SELECT "driverId" FROM nearby_driver_ring_events WHERE "requestId" = $1`, [change.id])
        : await this.db.query(`SELECT b."passengerId" AS "userId" FROM bookings b WHERE b.id = $1
            UNION SELECT t."driverId" FROM bookings b JOIN trips t ON t.id = b."tripId" WHERE b.id = $1`, [change.id]);
      for (const { userId } of recipients) if (!this.stopped) this.realtime.publish(userId, {
        kind: 'changed', ...(change.kind === 'request' ? { requestId: change.id } : { bookingId: change.id }),
        terminal: change.terminal,
      });
    } catch { this.logger.warn('Ride state hint deferred to REST reconciliation.'); }
  }
}
