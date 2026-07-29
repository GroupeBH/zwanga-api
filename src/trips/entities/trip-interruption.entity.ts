import type { Point } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Booking } from '../../bookings/entities/booking.entity';
import { User } from '../../users/entities/user.entity';
import { Trip } from './trip.entity';

export enum TripInterruptionReason {
  EMERGENCY = 'emergency',
  HEALTH = 'health',
  SAFETY = 'safety',
  ROUTE_ISSUE = 'route_issue',
  PERSONAL = 'personal',
  OTHER = 'other',
}

export enum TripInterruptionStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
}

export enum TripInterruptionConfirmationStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  REJECTED = 'rejected',
}

@Entity('passenger_trip_interruption_requests')
@Index('IDX_passenger_trip_interruptions_booking_status', [
  'bookingId',
  'status',
])
@Index('IDX_passenger_trip_interruptions_one_pending', ['bookingId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
export class PassengerTripInterruptionRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column({ type: 'uuid' })
  bookingId: string;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking;

  @Column({ type: 'uuid' })
  passengerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'passengerId' })
  passenger: User;

  @Column({
    type: 'enum',
    enum: TripInterruptionReason,
    enumName: 'trip_interruption_reason_enum',
    default: TripInterruptionReason.OTHER,
  })
  reason: TripInterruptionReason;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({
    type: 'enum',
    enum: TripInterruptionStatus,
    enumName: 'trip_interruption_status_enum',
    default: TripInterruptionStatus.PENDING,
  })
  status: TripInterruptionStatus;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  requestedLocation: Point | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  requestedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  rejectedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  confirmedByDriverId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'confirmedByDriverId' })
  confirmedByDriver: User | null;

  @Column({ type: 'uuid', nullable: true })
  rejectedByDriverId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'rejectedByDriverId' })
  rejectedByDriver: User | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('driver_trip_interruption_requests')
@Index('IDX_driver_trip_interruptions_trip_status', ['tripId', 'status'])
@Index('IDX_driver_trip_interruptions_one_pending', ['tripId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
export class DriverTripInterruptionRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column({ type: 'uuid' })
  requestedByDriverId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requestedByDriverId' })
  requestedByDriver: User;

  @Column({
    type: 'enum',
    enum: TripInterruptionReason,
    enumName: 'trip_interruption_reason_enum',
    default: TripInterruptionReason.OTHER,
  })
  reason: TripInterruptionReason;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({
    type: 'enum',
    enum: TripInterruptionStatus,
    enumName: 'trip_interruption_status_enum',
    default: TripInterruptionStatus.PENDING,
  })
  status: TripInterruptionStatus;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  requestedLocation: Point | null;

  @Column({ type: 'int', default: 0 })
  requiredPassengerCount: number;

  @Column({ type: 'int', default: 0 })
  confirmedPassengerCount: number;

  @Column({ type: 'int', default: 0 })
  rejectedPassengerCount: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  requestedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  rejectedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @OneToMany(
    () => DriverTripInterruptionConfirmation,
    (confirmation) => confirmation.request,
  )
  confirmations: DriverTripInterruptionConfirmation[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('driver_trip_interruption_confirmations')
@Index('IDX_driver_trip_interruption_confirmations_request', ['requestId'])
@Index('IDX_driver_trip_interruption_confirmations_trip_passenger', [
  'tripId',
  'passengerId',
])
@Index('IDX_driver_trip_interruption_confirmations_unique_booking', [
  'requestId',
  'bookingId',
], {
  unique: true,
})
export class DriverTripInterruptionConfirmation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  requestId: string;

  @ManyToOne(
    () => DriverTripInterruptionRequest,
    (request) => request.confirmations,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({ name: 'requestId' })
  request: DriverTripInterruptionRequest;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => Trip, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column({ type: 'uuid' })
  bookingId: string;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking;

  @Column({ type: 'uuid' })
  passengerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'passengerId' })
  passenger: User;

  @Column({
    type: 'enum',
    enum: TripInterruptionConfirmationStatus,
    enumName: 'trip_interruption_confirmation_status_enum',
    default: TripInterruptionConfirmationStatus.PENDING,
  })
  status: TripInterruptionConfirmationStatus;

  @Column({ type: 'timestamp', nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  rejectedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
