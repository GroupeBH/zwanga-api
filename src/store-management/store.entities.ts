import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  StoreJobTask,
  StoreKind,
  StorePlatform,
  StoreRange,
} from './store.types';
import { STORE_OPERATION_ENTITIES } from './store-operations.entities';

@Entity('store_records')
@Index('UQ_store_record', ['platform', 'appId', 'kind', 'externalId'], {
  unique: true,
})
@Index('IDX_store_records_page', [
  'platform',
  'appId',
  'kind',
  'syncedAt',
  'id',
])
export class StoreRecord {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) platform: StorePlatform;
  @Column({ type: 'text' }) appId: string;
  @Column({ type: 'text' }) kind: StoreKind;
  @Column({ type: 'text' }) externalId: string;
  @Column({ type: 'jsonb' }) content: Record<string, any>;
  @Column({ default: true }) isCurrent: boolean;
  @Column({ type: 'timestamptz', default: () => 'now()' }) syncedAt: Date;
}

@Entity('store_metrics')
@Index(
  'UQ_store_metric',
  ['platform', 'appId', 'dataset', 'date', 'metric', 'dimension'],
  { unique: true },
)
@Index('IDX_store_metrics_period', ['platform', 'appId', 'date', 'metric'])
export class StoreMetric {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) platform: StorePlatform;
  @Column({ type: 'text' }) appId: string;
  @Column({ type: 'text' }) dataset: string;
  @Column({ type: 'date' }) date: string;
  @Column({ type: 'text' }) metric: string;
  @Column({ type: 'text' }) dimension: string;
  @Column({ type: 'numeric', precision: 22, scale: 6 }) value: string;
  @CreateDateColumn({ type: 'timestamptz' }) importedAt: Date;
}

@Entity('store_sync_jobs')
@Index('UQ_store_job_request', ['requestKey'], { unique: true })
@Index('UQ_store_job_active', ['platform', 'appId', 'lane'], {
  unique: true,
  where: `state IN ('pending','running')`,
})
@Index('IDX_store_jobs_due', ['state', 'nextAttemptAt'])
@Index('IDX_store_jobs_history', ['platform', 'appId', 'createdAt', 'id'])
export class StoreSyncJob {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) requestKey: string;
  @Column({ type: 'text' }) platform: StorePlatform;
  @Column({ type: 'text' }) appId: string;
  @Column({ type: 'text' }) task: StoreJobTask;
  @Column({ type: 'text' }) lane: string;
  @Column({ type: 'jsonb' }) input: StoreRange & {
    recordId?: string;
    reply?: string;
    revision?: number;
  };
  @Column({ type: 'uuid', nullable: true }) actorId: string | null;
  @Column({ type: 'text', default: 'pending' }) state:
    'pending' | 'running' | 'succeeded' | 'failed' | 'unavailable' | 'unknown';
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ type: 'integer', default: 0 }) processed: number;
  @Column({ type: 'text', nullable: true }) errorCode: string | null;
  @Column({ type: 'uuid', nullable: true, select: false }) leaseToken:
    string | null;
  @Column({ type: 'timestamptz', nullable: true }) leaseUntil: Date | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) nextAttemptAt: Date;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
}

export const STORE_ENTITIES = [
  StoreRecord,
  StoreMetric,
  StoreSyncJob,
  ...STORE_OPERATION_ENTITIES,
];
