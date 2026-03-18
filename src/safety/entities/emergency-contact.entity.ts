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

@Entity('emergency_contacts')
@Index(['userId'])
export class EmergencyContact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  name: string; // Nom du contact d'urgence

  @Column()
  phone: string; // Numero de telephone du contact

  @Column({ type: 'varchar', nullable: true })
  email: string | null; // Email du contact d'urgence (optionnel)

  @Column({ type: 'varchar', nullable: true })
  relationship: string | null; // Relation (famille, ami, etc.)

  @Column({ default: true })
  isActive: boolean; // Si le contact est actif

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}