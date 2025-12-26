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
  Index
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Trip } from '../../trips/entities/trip.entity';
import { Message } from '../../chat/entities/message.entity';

export enum BookingStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

@Entity('bookings')
@Index(['tripId', 'passengerId'])
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tripId: string;

  @ManyToOne(() => Trip, (trip) => trip.bookings)
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column()
  passengerId: string;

  @ManyToOne(() => User, (user) => user.bookings)
  @JoinColumn({ name: 'passengerId' })
  passenger: User;

  @Column({ type: 'int', default: 1 })
  numberOfSeats: number;

  @Column({ type: 'varchar', nullable: true })
  passengerDestination: string | null;

  @Index('IDX_bookings_passenger_destination_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  passengerDestinationPoint: Point | null;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING,
  })
  status: BookingStatus;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'boolean', default: false })
  pickedUp: boolean; // Driver a confirmé la récupération

  @Column({ type: 'timestamp', nullable: true })
  pickedUpAt: Date | null; // Date de récupération confirmée par le driver

  @Column({ type: 'boolean', default: false })
  pickedUpConfirmedByPassenger: boolean; // Passager a confirmé la récupération

  @Column({ type: 'timestamp', nullable: true })
  pickedUpConfirmedAt: Date | null; // Date de confirmation par le passager

  @Column({ type: 'boolean', default: false })
  droppedOff: boolean; // Driver a confirmé la dépose

  @Column({ type: 'timestamp', nullable: true })
  droppedOffAt: Date | null; // Date de dépose confirmée par le driver

  @Column({ type: 'boolean', default: false })
  droppedOffConfirmedByPassenger: boolean; // Passager a confirmé la dépose

  @Column({ type: 'timestamp', nullable: true })
  droppedOffConfirmedAt: Date | null; // Date de confirmation par le passager

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Message, (message) => message.booking)
  messages: Message[];
}

