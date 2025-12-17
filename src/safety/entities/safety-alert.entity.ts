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
import { User } from '../../users/entities/user.entity';
import { Trip } from '../../trips/entities/trip.entity';
import { Booking } from '../../bookings/entities/booking.entity';

export enum SafetyAlertType {
  PHONE_SHUTDOWN = 'phone_shutdown', // Téléphone éteint brusquement
  LOW_BATTERY = 'low_battery', // Batterie faible
  MANUAL_ALERT = 'manual_alert', // Alerte manuelle
  NO_RESPONSE = 'no_response', // Pas de réponse
  EMERGENCY = 'emergency', // Urgence déclarée
}

export enum SafetyAlertStatus {
  ACTIVE = 'active', // Alerte active
  RESOLVED = 'resolved', // Alerte résolue
  FALSE_ALARM = 'false_alarm', // Fausse alerte
}

@Entity('safety_alerts')
@Index(['userId', 'status'])
@Index(['tripId'])
@Index(['bookingId'])
export class SafetyAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string; // Utilisateur concerné par l'alerte

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', nullable: true })
  tripId: string | null; // Trip associé (si l'alerte est liée à un trip)

  @ManyToOne(() => Trip, { nullable: true })
  @JoinColumn({ name: 'tripId' })
  trip: Trip | null;

  @Column({ type: 'varchar', nullable: true })
  bookingId: string | null; // Booking associé

  @ManyToOne(() => Booking, { nullable: true })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking | null;

  @Column({
    type: 'enum',
    enum: SafetyAlertType,
  })
  type: SafetyAlertType;

  @Column({
    type: 'enum',
    enum: SafetyAlertStatus,
    default: SafetyAlertStatus.ACTIVE,
  })
  status: SafetyAlertStatus;

  @Column({ type: 'text', nullable: true })
  message: string | null; // Message optionnel

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  latitude: number | null; // Position GPS au moment de l'alerte

  @Column({ type: 'decimal', precision: 10, scale: 6, nullable: true })
  longitude: number | null;

  @Column({ type: 'int', nullable: true })
  batteryLevel: number | null; // Niveau de batterie au moment de l'alerte (%)

  @Column({ type: 'timestamp', nullable: true })
  lastLocationUpdate: Date | null; // Dernière mise à jour de position

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt: Date | null; // Date de résolution

  @Column({ type: 'varchar', nullable: true })
  resolvedBy: string | null; // ID de l'utilisateur qui a résolu l'alerte

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

