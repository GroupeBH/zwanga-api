import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { TripPaymentMode } from '../../payments/enums/trip-payment-mode.enum';

export enum DriverEarningStatus {
  AVAILABLE = 'available',
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

@Entity('driver_earnings')
@Unique('UQ_driver_earnings_booking', ['bookingId'])
@Index(['driverId', 'status'])
@Index(['tripId'])
export class DriverEarning {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  bookingId: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'uuid' })
  passengerId: string;

  @Column({ type: 'varchar', length: 30 })
  paymentMode: TripPaymentMode;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  grossAmount: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  commissionRate: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  commissionAmount: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  netAmount: number;

  @Column({ type: 'varchar', length: 8, default: 'CDF' })
  currency: string;

  @Column({ type: 'varchar', length: 40, default: DriverEarningStatus.AVAILABLE })
  status: DriverEarningStatus;

  @Column({ type: 'timestamp', nullable: true })
  availableAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
