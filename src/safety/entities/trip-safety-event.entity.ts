import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { TripSafetyParticipant } from './trip-safety-participant.entity';
import { TripSafetyStatus } from './trip-safety-status.enum';

export enum TripSafetyEventType {
  TRACKING_CREATED = 'tracking_created',
  BOARDED = 'boarded',
  IN_TRANSIT = 'in_transit',
  TRUSTED_CONTACTS_NOTIFIED = 'trusted_contacts_notified',
  STATUS_CHANGED = 'status_changed',
  CONFIRMATION_RECEIVED = 'confirmation_received',
  ESTIMATED_END_REACHED = 'estimated_end_reached',
  AUTO_TRIP_END_DETECTED = 'auto_trip_end_detected',
  REMINDER_SENT = 'reminder_sent',
  ESCALATION_TRIGGERED = 'escalation_triggered',
  LATE_CONFIRMATION = 'late_confirmation',
  MONITORING_CANCELLED = 'monitoring_cancelled',
}

@Entity('trip_safety_events')
@Index(['participantId'])
@Index(['tripId'])
@Index(['userId'])
@Index(['type'])
export class TripSafetyEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  participantId: string;

  @ManyToOne(() => TripSafetyParticipant, (participant) => participant.events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'participantId' })
  participant: TripSafetyParticipant;

  @Column({ type: 'varchar' })
  tripId: string;

  @Column({ type: 'varchar', nullable: true })
  bookingId: string | null;

  @Column({ type: 'varchar' })
  userId: string;

  @Column({
    type: 'enum',
    enum: TripSafetyEventType,
  })
  type: TripSafetyEventType;

  @Column({
    type: 'enum',
    enum: TripSafetyStatus,
    nullable: true,
  })
  previousStatus: TripSafetyStatus | null;

  @Column({
    type: 'enum',
    enum: TripSafetyStatus,
    nullable: true,
  })
  nextStatus: TripSafetyStatus | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  occurredAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
