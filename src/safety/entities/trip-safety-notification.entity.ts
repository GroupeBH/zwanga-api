import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EmergencyContact } from './emergency-contact.entity';
import { TripSafetyParticipant } from './trip-safety-participant.entity';
import { TripSafetyChannel } from './trip-safety-channel.enum';

export enum TripSafetyNotificationType {
  BOARDING_SHARED = 'boarding_shared',
  REMINDER = 'reminder',
  ESCALATION = 'escalation',
  CONFIRMATION = 'confirmation',
  INCIDENT_SIGNAL = 'incident_signal',
}

export { TripSafetyChannel };

export enum TripSafetyNotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

@Entity('trip_safety_notifications')
@Index(['participantId'])
@Index(['tripId'])
@Index(['userId'])
@Index(['channel'])
@Index(['notificationType'])
@Index(['status'])
@Index(['dedupeKey'], { unique: true })
export class TripSafetyNotification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  participantId: string;

  @ManyToOne(() => TripSafetyParticipant, (participant) => participant.notifications, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'participantId' })
  participant: TripSafetyParticipant;

  @Column({ type: 'varchar' })
  tripId: string;

  @Column({ type: 'varchar', nullable: true })
  bookingId: string | null;

  @Column({ type: 'varchar', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', nullable: true })
  emergencyContactId: string | null;

  @ManyToOne(() => EmergencyContact, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'emergencyContactId' })
  emergencyContact: EmergencyContact | null;

  @Column({
    type: 'enum',
    enum: TripSafetyChannel,
  })
  channel: TripSafetyChannel;

  @Column({
    type: 'enum',
    enum: TripSafetyNotificationType,
  })
  notificationType: TripSafetyNotificationType;

  @Column({ type: 'varchar' })
  recipient: string;

  @Column({ type: 'varchar', nullable: true })
  subject: string | null;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({
    type: 'enum',
    enum: TripSafetyNotificationStatus,
    default: TripSafetyNotificationStatus.PENDING,
  })
  status: TripSafetyNotificationStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'varchar', nullable: true })
  providerMessageId: string | null;

  @Column({ type: 'varchar', nullable: true })
  dedupeKey: string | null;

  @Column({ type: 'timestamp', nullable: true })
  sentAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
