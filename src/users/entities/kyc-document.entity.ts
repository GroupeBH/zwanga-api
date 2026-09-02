import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum KycStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum KycProvider {
  LEGACY = 'legacy',
  DIDIT = 'didit',
}

@Entity('kyc_documents')
export class KycDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, insert: true, update: false })
  userId: string;

  @ManyToOne(() => User, (user) => user.kycDocuments)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', nullable: true })
  cniFrontUrl: string | null;

  @Column({ type: 'jsonb', nullable: true })
  cniFrontUrls: string[] | null; // Array of CNI front photo URLs (0, 1, or 2 photos)

  @Column({ type: 'varchar', nullable: true })
  cniBackUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  selfieUrl: string | null;

  @Column({
    type: 'enum',
    enum: KycStatus,
    default: KycStatus.PENDING,
  })
  status: KycStatus;

  @Column({
    type: 'enum',
    enum: KycProvider,
    enumName: 'kyc_documents_provider_enum',
    default: KycProvider.LEGACY,
  })
  provider: KycProvider;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  documentNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  diditSessionId: string | null;

  @Column({ type: 'integer', nullable: true })
  diditSessionNumber: number | null;

  @Column({ type: 'varchar', nullable: true })
  diditWorkflowId: string | null;

  @Column({ type: 'varchar', nullable: true })
  diditVendorData: string | null;

  @Column({ type: 'varchar', nullable: true })
  diditSessionStatus: string | null;

  @Column({ type: 'timestamp', nullable: true })
  diditLastSyncedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  providerMetadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

