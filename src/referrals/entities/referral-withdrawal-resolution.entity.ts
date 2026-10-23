import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ReferralWithdrawal } from './referral-withdrawal.entity';

/** One immutable administrative release per withdrawal; never a provider cancellation. */
@Entity('referral_withdrawal_resolutions')
export class ReferralWithdrawalResolution {
  @PrimaryColumn({ type: 'uuid' })
  withdrawalId: string;

  @ManyToOne(() => ReferralWithdrawal, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'withdrawalId' })
  withdrawal: ReferralWithdrawal;

  @Index('IDX_referral_withdrawal_resolution_actor')
  @Column({ type: 'uuid' })
  actorId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actorId' })
  actor: User;

  @Column({ type: 'varchar', length: 120 })
  expectedReference: string;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'varchar', length: 200 })
  evidenceReference: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
