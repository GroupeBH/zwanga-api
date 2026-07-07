import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Booking } from '../../bookings/entities/booking.entity';
import { Trip } from '../../trips/entities/trip.entity';
import { User } from '../../users/entities/user.entity';

@Entity('trip_share_links')
@Index(['token'], { unique: true })
@Index(['tripId'])
@Index(['bookingId'])
@Index(['ownerId'])
export class TripShareLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 96 })
  token: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column({ type: 'uuid', nullable: true })
  bookingId: string | null;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking | null;

  @Column({ type: 'uuid' })
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @Column({ type: 'varchar', length: 160, nullable: true })
  recipientEmail: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  recipientName: string | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastAccessedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
