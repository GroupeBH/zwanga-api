import type { Point } from 'typeorm';
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
import { User } from '../../users/entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';

export enum RecurringTripTemplateStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
}

@Entity('recurring_trip_templates')
@Index(['driverId', 'status'])
@Index(['startDate'])
export class RecurringTripTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  driverId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column()
  vehicleId: string;

  @ManyToOne(() => Vehicle, { nullable: false })
  @JoinColumn({ name: 'vehicleId' })
  vehicle: Vehicle;

  @Column()
  departureLocation: string;

  @Index('IDX_recurring_trip_templates_departure_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  departurePoint: Point;

  @Column()
  arrivalLocation: string;

  @Index('IDX_recurring_trip_templates_arrival_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  arrivalPoint: Point;

  @Column({ type: 'int' })
  departureTimeMinutes: number;

  @Column({ type: 'int', array: true })
  weekdays: number[];

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date', nullable: true })
  endDate: string | null;

  @Column({ type: 'int' })
  totalSeats: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  pricePerSeat: number;

  @Column({ type: 'boolean', default: false })
  isFree: boolean;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: RecurringTripTemplateStatus,
    default: RecurringTripTemplateStatus.ACTIVE,
  })
  status: RecurringTripTemplateStatus;

  @Column({ type: 'date', nullable: true })
  lastGeneratedDate: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
