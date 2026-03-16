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
import { EmergencyContact } from './emergency-contact.entity';
import { TripSafetyParticipant } from './trip-safety-participant.entity';
import { TripSafetyChannel } from './trip-safety-channel.enum';

@Entity('trip_safety_contacts')
@Index(['participantId'])
@Index(['emergencyContactId'])
@Index(['participantId', 'emergencyContactId'], { unique: true })
export class TripSafetyContact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  participantId: string;

  @ManyToOne(() => TripSafetyParticipant, (participant) => participant.trustedContacts, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'participantId' })
  participant: TripSafetyParticipant;

  @Column({ type: 'varchar' })
  emergencyContactId: string;

  @ManyToOne(() => EmergencyContact, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'emergencyContactId' })
  emergencyContact: EmergencyContact;

  // Snapshot fields preserve auditability even if the source contact changes later.
  @Column({ type: 'varchar' })
  contactName: string;

  @Column({ type: 'varchar' })
  contactPhone: string;

  @Column({ type: 'varchar', nullable: true })
  contactEmail: string | null;

  @Column({ type: 'simple-array', default: TripSafetyChannel.WHATSAPP })
  channels: TripSafetyChannel[];

  @Column({ type: 'timestamp', nullable: true })
  lastNotifiedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
