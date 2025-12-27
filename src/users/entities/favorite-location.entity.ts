import type { Point } from 'typeorm';
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
import { User } from './user.entity';

export enum FavoriteLocationType {
  HOME = 'home',
  WORK = 'work',
  OTHER = 'other',
}

@Entity('favorite_locations')
@Index(['userId'])
@Index(['userId', 'type'])
export class FavoriteLocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @ManyToOne(() => User, (user) => user.favoriteLocations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  name: string; // Ex: "Domicile", "Bureau", "Maison de maman"

  @Column()
  address: string; // Adresse textuelle complète

  @Index('IDX_favorite_locations_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  point: Point; // Coordonnées géographiques

  @Column({
    type: 'enum',
    enum: FavoriteLocationType,
    default: FavoriteLocationType.OTHER,
  })
  type: FavoriteLocationType;

  @Column({ default: false })
  isDefault: boolean; // Lieu par défaut pour ce type

  @Column({ type: 'text', nullable: true })
  notes: string | null; // Notes optionnelles

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

