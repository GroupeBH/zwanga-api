import type { Point } from 'typeorm';
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
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { RecurringTripTemplate } from './recurring-trip-template.entity';

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
@Index(['recurringTemplateId', 'recurringOccurrenceDate'])
export class Trip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  driverId: string;

  @ManyToOne(() => User, (user) => user.trips)
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column({ type: 'varchar', nullable: true })
  vehicleId: string | null;

  @ManyToOne(() => Vehicle, { nullable: true })
  @JoinColumn({ name: 'vehicleId' })
  vehicle: Vehicle | null;

  @Column()
  departureLocation: string;

  @Index('IDX_trips_departure_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  departurePoint: Point;

  @Column()
  arrivalLocation: string;

  @Index('IDX_trips_arrival_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  arrivalPoint: Point;

  @Column({ type: 'timestamp' })
  departureDate: Date;

  @Column({ type: 'int', nullable: true })
  totalSeats: number | null;

  @Column({ type: 'int' })
  availableSeats: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  pricePerSeat: number;

  @Column({ type: 'boolean', default: false })
  isFree: boolean;

  @Column({ nullable: true })
  description: string;

  @Column({
    type: 'enum',
    enum: TripStatus,
    default: TripStatus.PENDING,
  })
  status: TripStatus;

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  currentLocation: Point;

  @Column({ type: 'timestamp', nullable: true })
  lastLocationUpdateAt: Date | null;

  @Column({ type: 'boolean', default: false })
  departureReminderNotified: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  driverSafetyEmergencyContactIds: string[];

  @Column({ type: 'boolean', default: false })
  isPrivate: boolean;

  @Column({ type: 'varchar', nullable: true })
  tripRequestId: string | null;

  @Column({ type: 'varchar', nullable: true })
  recurringTemplateId: string | null;

  @ManyToOne(() => RecurringTripTemplate, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recurringTemplateId' })
  recurringTemplate: RecurringTripTemplate | null;

  @Column({ type: 'date', nullable: true })
  recurringOccurrenceDate: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Booking, (booking) => booking.trip)
  bookings: Booking[];
}
