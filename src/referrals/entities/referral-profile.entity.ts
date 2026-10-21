import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('referral_profiles')
@Index(['userId'], { unique: true })
@Index(['code'], { unique: true })
@Index(['linkToken'], { unique: true })
@Index(['referredByUserId'])
export class ReferralProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 16 })
  code: string;

  @Column({ type: 'varchar', length: 64 })
  linkToken: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  shareLinkUrl: string | null;

  @Column({ type: 'timestamp', nullable: true })
  shareLinkGeneratedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  referredByUserId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'referredByUserId' })
  referredByUser: User | null;

  @Column({ type: 'timestamp', nullable: true })
  referredAt: Date | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  attributionProvider: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  attributionLinkToken: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  attributionReferringLink: string | null;

  @Column({ type: 'timestamp', nullable: true })
  attributionCapturedAt: Date | null;

  // Non-financial audit of an admin assignment; never exposed by default reads.
  @Column({ type: 'uuid', nullable: true, select: false })
  attributionAdminId: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true, select: false })
  attributionAdminReason: string | null;

  @Column({ type: 'timestamp', nullable: true })
  qualifiedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  rewardWindowEndsAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
