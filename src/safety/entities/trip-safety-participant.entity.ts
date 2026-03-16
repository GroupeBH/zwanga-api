import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Trip } from '../../trips/entities/trip.entity';
import { Booking } from '../../bookings/entities/booking.entity';
import { TripSafetyContact } from './trip-safety-contact.entity';
import { TripSafetyEvent } from './trip-safety-event.entity';
import { TripSafetyNotification } from './trip-safety-notification.entity';
import { TripSafetyChannel } from './trip-safety-channel.enum';
import { TripSafetyStatus } from './trip-safety-status.enum';

export enum TripSafetyParticipantRole {
  DRIVER = 'driver',
  PASSENGER = 'passenger',
}

@Entity('trip_safety_participants')
@Index(['tripId'])
@Index(['userId'])
@Index(['status'])
@Index(['participantRef'], { unique: true })
@Index(['trackingCode'], { unique: true })
export class TripSafetyParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Stable reference used to keep one safety lifecycle per person per trip context.
  @Column({ type: 'varchar' })
  participantRef: string;

  @Column({ type: 'varchar' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column({ type: 'varchar', nullable: true })
  bookingId: string | null;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking | null;

  @Column({ type: 'varchar' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({
    type: 'enum',
    enum: TripSafetyParticipantRole,
  })
  role: TripSafetyParticipantRole;

  @Column({
    type: 'enum',
    enum: TripSafetyStatus,
    default: TripSafetyStatus.PENDING,
  })
  status: TripSafetyStatus;

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  boardedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  inTransitAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  estimatedEndAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  tripEndedDetectedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  droppedOffAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  arrivedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  reminderSentAt: Date | null;

  @Column({ type: 'int', default: 0 })
  reminderCount: number;

  @Column({ type: 'timestamp', nullable: true })
  escalatedAt: Date | null;

  @Column({ type: 'boolean', default: false })
  isEscalated: boolean;

  @Column({ type: 'simple-array', default: TripSafetyChannel.WHATSAPP })
  notificationChannels: TripSafetyChannel[];

  @Column({ type: 'int', default: 10 })
  reminderDelayMinutes: number;

  @Column({ type: 'int', default: 15 })
  escalationDelayMinutes: number;

  @Column({ type: 'varchar' })
  trackingCode: string;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date | null;

  @OneToMany(() => TripSafetyContact, (contact) => contact.participant)
  trustedContacts: TripSafetyContact[];

  @OneToMany(() => TripSafetyEvent, (event) => event.participant)
  events: TripSafetyEvent[];

  @OneToMany(() => TripSafetyNotification, (notification) => notification.participant)
  notifications: TripSafetyNotification[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
