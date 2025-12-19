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

export enum NotificationStatus {
  SENT = 'sent',
  FAILED = 'failed',
  PENDING = 'pending',
}

@Entity('notifications')
@Index(['userId', 'createdAt'])
@Index(['userId', 'isRead'])
@Index(['userId', 'isActive'])
@Index(['status'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  userId: string | null; // ID de l'utilisateur destinataire (peut être null pour les notifications multicast)

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  @Column({ type: 'varchar' })
  fcmToken: string; // Token FCM utilisé pour l'envoi

  @Column({ type: 'varchar' })
  title: string; // Titre de la notification

  @Column({ type: 'text' })
  body: string; // Corps de la notification

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, any> | null; // Données supplémentaires de la notification

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
  })
  status: NotificationStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null; // Message d'erreur si l'envoi a échoué

  @Column({ type: 'varchar', nullable: true })
  messageId: string | null; // ID du message retourné par FCM (si disponible)

  @Column({ type: 'boolean', default: false })
  isRead: boolean; // Si la notification a été lue par l'utilisateur

  @Column({ type: 'timestamp', nullable: true })
  readAt: Date | null; // Date de lecture de la notification

  @Column({ type: 'boolean', default: true })
  isActive: boolean; // Si la notification est active (affichée dans la liste)

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

