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

export enum ReportReason {
  INAPPROPRIATE_BEHAVIOR = 'inappropriate_behavior', // Comportement inapproprié
  HARASSMENT = 'harassment', // Harcèlement
  SAFETY_CONCERN = 'safety_concern', // Préoccupation de sécurité
  FRAUD = 'fraud', // Fraude
  OTHER = 'other', // Autre
}

export enum ReportStatus {
  PENDING = 'pending', // En attente de traitement
  UNDER_REVIEW = 'under_review', // En cours d'examen
  RESOLVED = 'resolved', // Résolu
  DISMISSED = 'dismissed', // Rejeté
}

@Entity('user_reports')
@Index(['reportedUserId'])
@Index(['reporterId'])
@Index(['status'])
export class UserReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  reporterId: string; // Utilisateur qui fait le signalement

  @ManyToOne(() => User)
  @JoinColumn({ name: 'reporterId' })
  reporter: User;

  @Column()
  reportedUserId: string; // Utilisateur signalé

  @ManyToOne(() => User)
  @JoinColumn({ name: 'reportedUserId' })
  reportedUser: User;

  @Column({
    type: 'enum',
    enum: ReportReason,
  })
  reason: ReportReason;

  @Column({ type: 'text' })
  description: string; // Description détaillée du signalement

  @Column({
    type: 'enum',
    enum: ReportStatus,
    default: ReportStatus.PENDING,
  })
  status: ReportStatus;

  @Column({ type: 'varchar', nullable: true })
  tripId: string | null; // Trip associé (si le signalement est lié à un trip)

  @ManyToOne(() => Trip, { nullable: true })
  @JoinColumn({ name: 'tripId' })
  trip: Trip | null;

  @Column({ type: 'varchar', nullable: true })
  bookingId: string | null; // Booking associé

  @ManyToOne(() => Booking, { nullable: true })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking | null;

  @Column({ type: 'varchar', nullable: true })
  reviewedBy: string | null; // ID de l'admin qui a examiné le signalement

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  adminNotes: string | null; // Notes de l'admin

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

