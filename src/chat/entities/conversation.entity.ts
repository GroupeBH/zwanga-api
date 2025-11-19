import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Message } from './message.entity';
import { ConversationParticipant } from './conversation-participant.entity';

export enum ConversationType {
  GENERAL = 'general',
  SUPPORT = 'support',
  BOOKING = 'booking',
}

@Entity('conversations')
@Index(['bookingId'], { unique: true, where: '"bookingId" IS NOT NULL' })
@Index(['type'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  title: string;

  @Column({ nullable: true })
  bookingId: string;

  @Column({
    type: 'enum',
    enum: ConversationType,
    default: ConversationType.GENERAL,
  })
  type: ConversationType;

  @Column({ type: 'timestamp', nullable: true })
  lastMessageAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Message, (message) => message.conversation)
  messages: Message[];

  @OneToMany(
    () => ConversationParticipant,
    (participant) => participant.conversation,
  )
  participants: ConversationParticipant[];
}

