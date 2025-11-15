import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Booking } from '../../bookings/entities/booking.entity';

export enum TripStatus {
  PENDING = 'upcoming',
  ACTIVE = 'ongoing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

@Entity('trips')
@Index(['departureLocation'])
@Index(['arrivalLocation'])
@Index(['departureDate'])
export class Trip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  driverId: string;

  @ManyToOne(() => User, (user) => user.trips)
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column()
  departureLocation: string;

  @Column('decimal', { precision: 10, scale: 8 })
  departureLatitude: number;

  @Column('decimal', { precision: 11, scale: 8 })
  departureLongitude: number;

  @Column()
  arrivalLocation: string;

  @Column('decimal', { precision: 10, scale: 8 })
  arrivalLatitude: number;

  @Column('decimal', { precision: 11, scale: 8 })
  arrivalLongitude: number;

  @Column({ type: 'timestamp' })
  departureDate: Date;

  @Column({ type: 'int' })
  availableSeats: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  pricePerSeat: number;

  @Column({ nullable: true })
  description: string;

  @Column({
    type: 'enum',
    enum: TripStatus,
    default: TripStatus.PENDING,
  })
  status: TripStatus;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Booking, (booking) => booking.trip)
  bookings: Booking[];
}

