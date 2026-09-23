import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type WalletWithdrawalStatus =
  'pending' | 'initiated' | 'succeeded' | 'failed' | 'cancelled' | 'review';

@Entity('wallet_withdrawals')
@Index('UQ_wallet_withdrawals_request', ['userId', 'idempotencyKey'], {
  unique: true,
})
@Index('IDX_wallet_withdrawals_user_created', ['userId', 'createdAt'])
@Index('IDX_wallet_withdrawals_status', ['status'])
@Check(
  'CHK_wallet_withdrawal_positive',
  'tokens > 0 AND amount > 0 AND "moneyPerToken" > 0',
)
@Check(
  'CHK_wallet_withdrawal_status',
  "status IN ('pending', 'initiated', 'succeeded', 'failed', 'cancelled', 'review')",
)
export class WalletWithdrawal {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) userId: string;
  @Column({ type: 'uuid' }) idempotencyKey: string;
  @Column({ type: 'decimal', precision: 12, scale: 2 }) tokens: number;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) amount: number;
  @Column({ type: 'decimal', precision: 12, scale: 4 }) moneyPerToken: number;
  @Column({ type: 'varchar', length: 8 }) currency: string;
  @Column({ type: 'varchar', length: 30 }) phone: string;
  @Column({ type: 'varchar', length: 40, default: 'pending' })
  status: WalletWithdrawalStatus;
  @Column({ type: 'uuid', nullable: true }) paymentTransactionId: string | null;
  @Column({ type: 'timestamp', nullable: true }) releasedAt: Date | null;
  @Column({ type: 'timestamp', nullable: true }) processedAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
