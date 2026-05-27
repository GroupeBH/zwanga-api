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

@Entity('kyc_documents')
export class KycDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true, insert: true, update: false })
  userId: string;

  @ManyToOne(() => User, (user) => user.kycDocuments)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', nullable: true })
  cniFrontUrl: string | null;

  @Column({ type: 'jsonb', nullable: true })
  cniFrontUrls: string[] | null; // Array of CNI front photo URLs (0, 1, or 2 photos)

  @Column({ nullable: true })
  cniBackUrl: string;

  @Column({ nullable: true })
  selfieUrl: string;

  @Column({
    type: 'enum',
    enum: KycStatus,
    default: KycStatus.PENDING,
  })
  status: KycStatus;

  @Column({ nullable: true })
  rejectionReason: string;

  @Column({ nullable: true })
  reviewedBy: string;

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt: Date;

  @Column({ nullable: true })
  documentNumber: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

