import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type DriverPayoutEventAction =
  | 'review_requested'
  | 'released_confirmed_not_paid'
  | 'reconciled'
  | 'late_success'
  | 'late_success_review_closed';

/** Append-only in application code; never included in driver-facing responses. */
@Entity('driver_payout_events')
@Index('IDX_driver_payout_events_payout_created', ['payoutId', 'createdAt'])
export class DriverPayoutEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) payoutId: string;
  @Column({ type: 'uuid', nullable: true }) actorId: string | null;
  @Column({ type: 'varchar', length: 40 }) action: DriverPayoutEventAction;
  @Column({ type: 'varchar', length: 500 }) reason: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) evidenceReference:
    string | null;
  @Column({ type: 'jsonb', nullable: true }) details: Record<
    string,
    unknown
  > | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
