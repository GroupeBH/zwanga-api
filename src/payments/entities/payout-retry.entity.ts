import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export type PayoutRetryKind = 'driver_payout' | 'referral_withdrawal';

/** Immutable audit link: one replacement per source, never reset a provider payment. */
@Entity('payout_retries')
@Index('UQ_payout_retry_replacement', ['replacementId'], { unique: true })
@Index('IDX_payout_retry_actor', ['actorId'])
export class PayoutRetry {
  @PrimaryColumn({ type: 'varchar', length: 30 })
  kind: PayoutRetryKind;
  @PrimaryColumn({ type: 'uuid' })
  sourceId: string;
  @Column({ type: 'uuid' })
  replacementId: string;
  @Column({ type: 'uuid' })
  actorId: string;
  @Column({ type: 'varchar', length: 120 })
  expectedReference: string;
  @Column({ type: 'varchar', length: 500 })
  reason: string;
  @Column({ type: 'varchar', length: 200 })
  evidenceReference: string;
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
