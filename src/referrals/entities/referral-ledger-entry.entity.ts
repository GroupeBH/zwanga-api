import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PaymentTransaction } from '../../payments/entities/payment-transaction.entity';
import { ReferralAccount } from './referral-account.entity';
import { ReferralReward } from './referral-reward.entity';
import { ReferralWithdrawal } from './referral-withdrawal.entity';

export enum ReferralLedgerEntryType {
  REWARD_PENDING = 'reward_pending',
  REWARD_RELEASED = 'reward_released',
  REWARD_REVERSED = 'reward_reversed',
  WITHDRAWAL_RESERVED = 'withdrawal_reserved',
  WITHDRAWAL_SUCCEEDED = 'withdrawal_succeeded',
  WITHDRAWAL_REFUNDED = 'withdrawal_refunded',
}

export enum ReferralBalanceBucket {
  PENDING = 'pending',
  AVAILABLE = 'available',
  RESERVED = 'reserved',
  WITHDRAWN = 'withdrawn',
}

@Entity('referral_ledger_entries')
@Index(['userId', 'createdAt'])
@Index(['rewardId'])
@Index(['withdrawalId'])
export class ReferralLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  accountId: string;

  @ManyToOne(() => ReferralAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'accountId' })
  account: ReferralAccount;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 40 })
  type: ReferralLedgerEntryType;

  @Column({ type: 'varchar', length: 20 })
  bucket: ReferralBalanceBucket;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amountTokens: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  balanceAfter: number;

  @Column({ type: 'uuid', nullable: true })
  rewardId: string | null;

  @ManyToOne(() => ReferralReward, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'rewardId' })
  reward: ReferralReward | null;

  @Column({ type: 'uuid', nullable: true })
  withdrawalId: string | null;

  @ManyToOne(() => ReferralWithdrawal, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'withdrawalId' })
  withdrawal: ReferralWithdrawal | null;

  @Column({ type: 'uuid', nullable: true })
  paymentTransactionId: string | null;

  @ManyToOne(() => PaymentTransaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'paymentTransactionId' })
  paymentTransaction: PaymentTransaction | null;

  @Column({ type: 'varchar', length: 500 })
  description: string;

  @CreateDateColumn()
  createdAt: Date;
}
