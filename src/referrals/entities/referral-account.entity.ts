import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('referral_accounts')
@Index(['userId'], { unique: true })
export class ReferralAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  pendingTokens: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  availableTokens: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  reservedTokens: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  withdrawnTokens: number;

  @Column({ type: 'varchar', length: 8, default: 'PTS' })
  currency: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
