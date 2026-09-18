import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export enum WalletAccountType {
  POINTS = 'points',
}

@Entity('wallet_accounts')
@Unique('UQ_wallet_accounts_user_type', ['userId', 'type'])
@Index(['userId', 'type'])
@Check('CHK_wallet_accounts_balance_non_negative', '"balance" >= 0')
@Check(
  'CHK_wallet_accounts_withdrawable',
  '"withdrawableBalance" >= 0 AND "withdrawableBalance" <= "balance" AND "reservedWithdrawalBalance" >= 0',
)
export class WalletAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 40 })
  type: WalletAccountType;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  balance: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  withdrawableBalance: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  reservedWithdrawalBalance: number;

  // Provider contradictions require reconciliation before any further debit.
  @Column({ type: 'boolean', default: false })
  withdrawalsBlocked: boolean;

  @Column({ type: 'varchar', length: 8, default: 'CDF' })
  currency: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
