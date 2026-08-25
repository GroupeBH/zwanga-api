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

export enum ReferralRewardSourceType {
  SUBSCRIPTION_PAYMENT = 'subscription_payment',
  BOOKING_PAYMENT = 'booking_payment',
}

export enum ReferralRewardStatus {
  PENDING = 'pending',
  AVAILABLE = 'available',
  REVERSED = 'reversed',
}

@Entity('referral_rewards')
@Index(['sourceType', 'sourceEntityId'], { unique: true })
@Index(['referrerUserId', 'status'])
@Index(['referredUserId', 'createdAt'])
export class ReferralReward {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  referrerUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'referrerUserId' })
  referrerUser: User;

  @Column({ type: 'uuid' })
  referredUserId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'referredUserId' })
  referredUser: User;

  @Column({ type: 'varchar', length: 40 })
  sourceType: ReferralRewardSourceType;

  @Column({ type: 'uuid' })
  sourceEntityId: string;

  @Column({ type: 'uuid' })
  paymentTransactionId: string;

  @ManyToOne(() => PaymentTransaction, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'paymentTransactionId' })
  paymentTransaction: PaymentTransaction;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  grossAmount: number;

  @Column({ type: 'varchar', length: 8 })
  sourceCurrency: string;

  @Column({ type: 'decimal', precision: 7, scale: 6 })
  rate: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  rewardAmount: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  rewardTokens: number;

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  sourceMoneyPerToken: number;

  @Column({
    type: 'varchar',
    length: 30,
    default: ReferralRewardStatus.PENDING,
  })
  status: ReferralRewardStatus;

  @Column({ type: 'timestamp' })
  holdUntil: Date;

  @Column({ type: 'timestamp', nullable: true })
  availableAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  reversedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reversalReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
