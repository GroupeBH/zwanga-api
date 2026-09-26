import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  CaseState,
  ServiceApplication,
  ServiceCode,
  ServiceQuote,
  ServiceTerms,
} from './pro-service.types';

@Entity('pro_service_offerings')
export class ProServiceOffering {
  @PrimaryColumn('text') code: ServiceCode;
  @Column('text') name: string;
  @Column('text') description: string;
  @Column('text', { default: 'coming_soon' }) availability:
    'open' | 'coming_soon' | 'paused';
  @Column('jsonb', { nullable: true }) terms: ServiceTerms | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
@Entity('pro_service_cases')
@Index(['ownerId', 'createdAt', 'id'])
@Index(['status', 'createdAt', 'id'])
@Index(['serviceCode'])
@Index(['submissionKey'], { unique: true })
export class ProServiceCase {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid', { nullable: true }) ownerId: string | null;
  @Column('text') serviceCode: ServiceCode;
  @Column('text') origin: 'mobile' | 'web';
  @Column('uuid') submissionKey: string;
  @Column('jsonb') application: ServiceApplication;
  @Column('text', { default: 'submitted' }) status: CaseState;
  @Column('jsonb', { nullable: true }) quote: ServiceQuote | null;
  @Column('integer', { nullable: true }) acceptedQuoteVersion: number | null;
  @Column('timestamptz', { nullable: true }) acceptedAt: Date | null;
  @Column('text', { default: '' }) customerMessage: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
@Entity('pro_service_ledger')
@Index(['caseId', 'createdAt'])
@Index(['reference'], { unique: true })
export class ProServiceLedger {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') caseId: string;
  @Column('text') kind: 'deposit' | 'funding' | 'repayment';
  @Column('integer') amountMinor: number;
  @Column('text') currency: string;
  @Column('text') reference: string;
  @Column('text') evidence: string;
  @Column('uuid') recordedBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
@Entity('pro_service_documents')
@Index(['caseId', 'code'], { unique: true })
export class ProServiceDocument {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') caseId: string;
  @Column('text') code: string;
  @Column('text') label: string;
  @Column('text', { default: 'expected' }) status:
    'expected' | 'held' | 'release_ready' | 'returned';
  @Column('text', { default: '' }) storageLocation: string;
  @Column('text', { default: '' }) receipt: string;
  @Column('text', { default: '' }) returnReceipt: string;
  @Column('timestamptz', { nullable: true }) heldAt: Date | null;
  @Column('timestamptz', { nullable: true }) returnedAt: Date | null;
}
@Entity('pro_service_events')
@Index(['caseId', 'createdAt'])
export class ProServiceEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid', { nullable: true }) caseId: string | null;
  @Column('uuid', { nullable: true }) actorId: string | null;
  @Column('text') action: string;
  @Column('jsonb', { default: {} }) detail: Record<string, unknown>;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
export const PRO_SERVICE_ENTITIES = [
  ProServiceOffering,
  ProServiceCase,
  ProServiceLedger,
  ProServiceDocument,
  ProServiceEvent,
];
