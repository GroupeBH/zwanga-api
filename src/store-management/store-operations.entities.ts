import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { StorePlatform } from './store.types';

@Entity('store_integrations')
export class StoreIntegration {
  @PrimaryColumn({ type: 'text' }) platform: StorePlatform;
  @Column({ default: true }) enabled: boolean;
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` }) schedule: Record<
    string,
    number
  >;
  @Column({ type: 'timestamptz', nullable: true }) checkedAt: Date | null;
  @Column({ type: 'text', nullable: true }) errorCode: string | null;
  @Column({ type: 'jsonb', nullable: true }) capabilities: Record<
    string,
    unknown
  > | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
@Entity('store_access_grants')
export class StoreAccessGrant {
  @PrimaryColumn({ type: 'uuid' }) userId: string;
  @Column({ type: 'text' }) profile: string;
  @Column({ type: 'jsonb' }) permissions: string[];
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
@Entity('store_review_workflows')
export class StoreReviewWorkflow {
  @PrimaryColumn({ type: 'uuid' }) recordId: string;
  @Column({ type: 'text', default: 'new' }) status:
    | 'new'
    | 'in_progress'
    | 'draft'
    | 'pending_approval'
    | 'approved'
    | 'responded'
    | 'closed';
  @Column({ type: 'uuid', nullable: true }) assigneeId: string | null;
  @Column({ type: 'text', nullable: true }) draft: string | null;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @Column({ type: 'uuid', nullable: true }) preparedBy: string | null;
  @Column({ type: 'uuid', nullable: true }) approvedBy: string | null;
  @Column({ type: 'integer', nullable: true }) approvedRevision: number | null;
  @Column({ type: 'uuid', nullable: true }) publishedJobId: string | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
@Entity('store_audit_logs')
@Index('IDX_store_audit_page', ['createdAt', 'id'])
export class StoreAuditLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid', nullable: true }) actorId: string | null;
  @Column({ type: 'text' }) action: string;
  @Column({ type: 'text' }) subjectId: string;
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` }) details: Record<
    string,
    unknown
  >;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
@Entity('store_release_incidents')
@Index('IDX_store_incident_record', ['recordId', 'createdAt'])
export class StoreReleaseIncident {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) recordId: string;
  @Column({ type: 'text' }) category: string;
  @Column({ type: 'text' }) note: string;
  @Column({ type: 'text', nullable: true }) taskReference: string | null;
  @Column({ type: 'uuid', nullable: true }) ownerId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
@Entity('store_alert_rules')
export class StoreAlertRule {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) name: string;
  @Column({ type: 'text', nullable: true }) platform: StorePlatform | null;
  @Column({ type: 'text' }) type: string;
  @Column({ type: 'text', nullable: true }) metric: string | null;
  @Column({ type: 'double precision', nullable: true }) threshold:
    number | null;
  @Column({ type: 'text', default: 'warning' }) severity: string;
  @Column({ default: true }) enabled: boolean;
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` }) recipients: string[];
  @Column({ default: false }) email: boolean;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
@Entity('store_alert_events')
@Index('UQ_store_alert_event', ['eventKey'], { unique: true })
@Index('IDX_store_alert_page', ['createdAt', 'id'])
export class StoreAlertEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) eventKey: string;
  @Column({ type: 'uuid', nullable: true }) ruleId: string | null;
  @Column({ type: 'text' }) platform: StorePlatform;
  @Column({ type: 'text' }) code: string;
  @Column({ type: 'text' }) severity: string;
  @Column({ type: 'text' }) message: string;
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` }) recipients: string[];
  @Column({ type: 'text', default: 'not_requested' }) emailState: string;
  @Column({ type: 'timestamptz', nullable: true }) emailClaimedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) acknowledgedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) acknowledgedBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
export const STORE_OPERATION_ENTITIES = [
  StoreIntegration,
  StoreAccessGrant,
  StoreReviewWorkflow,
  StoreAuditLog,
  StoreReleaseIncident,
  StoreAlertRule,
  StoreAlertEvent,
];
