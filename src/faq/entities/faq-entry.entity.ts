import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('faq_entries')
@Index(['isPublished', 'locale', 'audience', 'order'])
export class FaqEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  question: string;

  @Column('text')
  answer: string;

  @Column({ nullable: true })
  category: string | null;

  @Column({ default: 'fr-CD' })
  locale: string;

  @Column({ nullable: true })
  audience: string | null;

  @Column({ type: 'text', nullable: true })
  keywords: string | null;

  @Column({ default: true })
  isPublished: boolean;

  @Column({ type: 'int', default: 0 })
  order: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

