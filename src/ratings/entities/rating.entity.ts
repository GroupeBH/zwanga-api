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

@Entity('ratings')
@Index(['ratedUserId', 'raterId'])
@Index('IDX_ratings_user_page', ['ratedUserId', 'createdAt', 'id'])
@Index('UQ_ratings_verified_interaction', ['raterId', 'ratedUserId', 'tripId'], {
  unique: true, where: '"verificationVersion" = 1',
})
export class Rating {
  @Column({ type: 'smallint', default: 0, select: false })
  verificationVersion: number;

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  ratedUserId: string;

  @ManyToOne(() => User, (user) => user.receivedRatings)
  @JoinColumn({ name: 'ratedUserId' })
  ratedUser: User;

  @Column()
  raterId: string;

  @ManyToOne(() => User, (user) => user.givenRatings)
  @JoinColumn({ name: 'raterId' })
  rater: User;

  @Column({ nullable: true })
  tripId: string;

  @ManyToOne(() => Trip, { nullable: true })
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column({ type: 'int' })
  rating: number; // 1-5

  @Column({ nullable: true })
  comment: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

