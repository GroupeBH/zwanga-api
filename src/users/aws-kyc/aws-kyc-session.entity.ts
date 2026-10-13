import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../entities/user.entity';
import { KycDocument } from '../entities/kyc-document.entity';
import type { AwsDocumentType, AwsKycState } from './aws-kyc.policy';

@Entity('aws_kyc_sessions')
@Index('UQ_aws_kyc_request', ['userId', 'requestId'], { unique: true })
@Index('IDX_aws_kyc_user_created', ['userId', 'createdAt'])
@Index('IDX_aws_kyc_created', ['createdAt'])
@Index('IDX_aws_kyc_queue', ['nextAttemptAt'], {
  where: `state IN ('documents','liveness','compare')`,
})
@Index('UQ_aws_kyc_active', ['userId'], {
  unique: true,
  where: `state <> 'failed'`,
})
export class AwsKycSession {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') userId: string;
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
  @Column('uuid', { unique: true }) kycId: string;
  @ManyToOne(() => KycDocument, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kycId' })
  kyc: KycDocument;
  @Column('uuid') requestId: string;
  @Column('uuid') archiveId: string;
  @Column('text') documentType: AwsDocumentType;
  @Column('text') identityHash: string;
  @Column('text') consentVersion: string;
  @Column('text') state: AwsKycState;
  @Column('text', { nullable: true }) objectKey: string | null;
  @Column('uuid', { nullable: true, unique: true }) livenessId: string | null;
  @Column('text') region: string;
  @Column('jsonb', { default: {} }) checks: Record<string, string>;
  @Column('integer', { default: 0 }) failures: number;
  @Column('integer', { default: 0 }) runs: number;
  @Column('uuid', { nullable: true }) leaseToken: string | null;
  @Column('timestamptz', { nullable: true }) leaseUntil: Date | null;
  @Column('timestamptz') expiresAt: Date;
  @Column('timestamptz', { default: () => 'now()' }) nextAttemptAt: Date;
  @Column('text', { nullable: true }) errorCode: string | null;
  @Column('text', { nullable: true, select: false }) reviewNote: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
