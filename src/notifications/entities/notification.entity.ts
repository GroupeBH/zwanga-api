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
@Index(['userId', 'isAutomatic', 'createdAt'])
@Index(['status'])
@Index('IDX_notifications_urgent_outbox', ['createdAt', 'id'], {
  where: `"eventKey" IS NOT NULL AND "isActive" = true AND status IN ('pending', 'failed') AND data ->> 'type' IN ('new_booking', 'driver_dispatch_offer')`,
})
@Index('IDX_notifications_outbox_pending', ['createdAt', 'id'], {
  where: `"eventKey" IS NOT NULL AND status = 'pending' AND "errorMessage" IS NULL AND "isActive" = true`,
})
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Stable business event identity; NULL for older/non-transactional notifications.
  @Index('UQ_notifications_event_key', { unique: true })
  @Column({ type: 'varchar', length: 200, nullable: true })
  eventKey: string | null;

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

  @Column({ type: 'boolean', default: false })
  isAutomatic: boolean; // Si la notification vient d'un job automatique non critique

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
