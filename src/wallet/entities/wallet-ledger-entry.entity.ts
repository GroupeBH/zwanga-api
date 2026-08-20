import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WalletAccount, WalletAccountType } from './wallet-account.entity';
import { PaymentTransaction } from '../../payments/entities/payment-transaction.entity';

export enum WalletLedgerEntryType {
  TOP_UP = 'top_up',
  LOYALTY_REWARD = 'loyalty_reward',
  BOOKING_PAYMENT = 'booking_payment',
  BOOKING_REFUND = 'booking_refund',
  BOOKING_FARE_ADJUSTMENT = 'booking_fare_adjustment',
  SUBSCRIPTION_PAYMENT = 'subscription_payment',
  SUBSCRIPTION_REWARD = 'subscription_reward',
  TRANSFER_OUT = 'transfer_out',
  TRANSFER_IN = 'transfer_in',
}

@Entity('wallet_ledger_entries')
@Index(['userId', 'createdAt'])
@Index(['relatedEntityType', 'relatedEntityId'])
@Index(['paymentTransactionId'])
export class WalletLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  accountId: string;

  @ManyToOne(() => WalletAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'accountId' })
  account: WalletAccount;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 40 })
  accountType: WalletAccountType;

  @Column({ type: 'varchar', length: 40 })
  type: WalletLedgerEntryType;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  balanceAfter: number;

  @Column({ type: 'varchar', length: 8, default: 'CDF' })
  currency: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  relatedEntityType: string | null;

  @Column({ type: 'uuid', nullable: true })
  relatedEntityId: string | null;

  @Column({ type: 'uuid', nullable: true })
  paymentTransactionId: string | null;

  @ManyToOne(() => PaymentTransaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'paymentTransactionId' })
  paymentTransaction: PaymentTransaction | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
