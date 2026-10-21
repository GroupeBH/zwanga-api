import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PaymentTransaction } from '../../payments/entities/payment-transaction.entity';
import { User } from '../../users/entities/user.entity';

export enum ReferralWithdrawalStatus {
  PENDING = 'pending',
  INITIATED = 'initiated',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('referral_withdrawals')
@Index(['userId', 'status'])
@Index(['paymentTransactionId'])
@Index('IDX_referral_withdrawal_intent', ['userId', 'idempotencyKey'], { unique: true, where: '"idempotencyKey" IS NOT NULL' })
@Index('IDX_referral_withdrawal_recent', ['userId', 'requestedAt'])
export class ReferralWithdrawal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid', nullable: true, update: false })
  idempotencyKey: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  tokens: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 8, default: 'CDF' })
  currency: string;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  moneyPerToken: number;

  @Column({ type: 'varchar', length: 30 })
  phone: string;

  @Column({
    type: 'varchar',
    length: 30,
    default: ReferralWithdrawalStatus.PENDING,
  })
  status: ReferralWithdrawalStatus;

  @Column({ type: 'uuid', nullable: true })
  paymentTransactionId: string | null;

  @ManyToOne(() => PaymentTransaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'paymentTransactionId' })
  paymentTransaction: PaymentTransaction | null;

  @Column({ type: 'timestamp' })
  requestedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  recoveryCheckedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
