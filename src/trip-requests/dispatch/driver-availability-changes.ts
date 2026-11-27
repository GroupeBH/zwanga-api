import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntitySubscriberInterface, QueryRunner, TransactionCommitEvent, TransactionRollbackEvent, UpdateEvent } from 'typeorm';
import { Trip } from '../../trips/entities/trip.entity';
import { TripRequest } from '../entities/trip-request.entity';
import { DriverAvailabilityWakeups } from './driver-availability-wakeups';

type AvailabilityChange = { kind: 'request' | 'trip'; id: string };

/** Bridges ORM cancellations/completions to dispatch, without invoking another
 * pool connection from a commit callback. Raw SQL retirement has an explicit
 * after-commit hook in SequentialDispatchService. Hints may be dropped on a
 * rollback/overflow: the durable cron is deliberately retained. */
@Injectable()
export class DriverAvailabilityChanges implements EntitySubscriberInterface, OnModuleDestroy {
  private pending = new WeakMap<QueryRunner, Map<string, AvailabilityChange>>();
  private ready = new Map<string, AvailabilityChange>();
  private draining = false;
  private stopped = false;
  constructor(private readonly db: DataSource, private readonly config: ConfigService,
    private readonly wakeups: DriverAvailabilityWakeups) { db.subscribers.push(this); }
  afterUpdate(event: UpdateEvent<Trip | TripRequest>) {
    if (this.config.get('DRIVER_DISPATCH_ENABLED') !== 'true') return;
    const kind = event.metadata.target === Trip ? 'trip' : event.metadata.target === TripRequest ? 'request' : null;
    const id = event.entity?.id ?? event.databaseEntity?.id;
    const status = event.entity?.status;
    if (!kind || !id || !status || event.databaseEntity?.status === status) return;
    if (kind === 'trip' && !['completed', 'cancelled'].includes(status)) return;
    if (kind === 'request' && ['pending', 'offers_received'].includes(status)) return;
    const change: AvailabilityChange = { kind, id };
    if (!event.queryRunner.isTransactionActive) { this.enqueue(change); return; }
    const changes = this.pending.get(event.queryRunner) ?? new Map<string, AvailabilityChange>();
    if (changes.size < 200) changes.set(kind + ':' + id, change);
    this.pending.set(event.queryRunner, changes);
  }
  afterTransactionCommit(event: TransactionCommitEvent) {
    if (event.queryRunner.isTransactionActive) return;
    const changes = this.pending.get(event.queryRunner);
    this.pending.delete(event.queryRunner);
    if (changes) for (const change of changes.values()) this.enqueue(change);
  }
  afterTransactionRollback(event: TransactionRollbackEvent) { this.pending.delete(event.queryRunner); }
  onModuleDestroy() {
    this.stopped = true; this.ready.clear();
    const index = this.db.subscribers.indexOf(this); if (index >= 0) this.db.subscribers.splice(index, 1);
  }
  private enqueue(change: AvailabilityChange) {
    if (this.stopped) return;
    if (this.ready.size < 200) this.ready.set(change.kind + ':' + change.id, change);
    if (!this.draining) { this.draining = true; void this.drain(); }
  }
  private async drain() {
    // Leave the originating QueryRunner time to release, even in autocommit.
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      while (!this.stopped && this.ready.size) {
        const [key, change] = this.ready.entries().next().value!;
        this.ready.delete(key);
        try {
          if (change.kind === 'request') await this.wakeups.requestReleased(change.id);
          else {
            const [trip] = await this.db.query(`SELECT "driverId" FROM trips WHERE id=$1
              AND status IN ('completed','cancelled')`, [change.id]);
            if (trip) await this.wakeups.driversAvailable([trip.driverId]);
          }
        } catch { /* A hint is optional; SQL cron remains the recovery path. */ }
      }
    } finally { this.draining = false; }
  }
}
