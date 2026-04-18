import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subscription } from './subscription.entity';

export enum AdministrativeDocumentType {
  DRIVER_LICENSE = 'driver_license',
  VEHICLE_REGISTRATION = 'vehicle_registration',
  VEHICLE_INSURANCE = 'vehicle_insurance',
  TECHNICAL_INSPECTION = 'technical_inspection',
  ROAD_TAX = 'road_tax',
  OPERATING_PERMIT = 'operating_permit',
  OTHER = 'other',
}

export enum DocumentFundingRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  FUNDED = 'funded',
  CANCELLED = 'cancelled',
}

@Entity('document_funding_requests')
@Index(['driverId', 'status'])
@Index(['subscriptionId'])
export class DocumentFundingRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  driverId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column({ type: 'varchar', nullable: true })
  subscriptionId: string | null;

  @ManyToOne(() => Subscription, { nullable: true })
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription | null;

  @Column({
    type: 'enum',
    enum: AdministrativeDocumentType,
  })
  documentType: AdministrativeDocumentType;

  @Column({ type: 'varchar', nullable: true })
  documentName: string | null;

  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  amountRequested: number | null;

  @Column({ type: 'varchar', length: 8, default: 'CDF' })
  currency: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: DocumentFundingRequestStatus,
    default: DocumentFundingRequestStatus.PENDING,
  })
  status: DocumentFundingRequestStatus;

  @Column({ type: 'text', nullable: true })
  adminNote: string | null;

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  reviewedByAdminId: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'reviewedByAdminId' })
  reviewedByAdmin: User | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
