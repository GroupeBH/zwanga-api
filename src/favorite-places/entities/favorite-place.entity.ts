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
import { User } from '../../users/entities/user.entity';

export enum FavoritePlaceType {
  HOME = 'home', // Domicile
  WORK = 'work', // Bureau
  OTHER = 'other', // Autre
}

@Entity('favorite_places')
@Index(['userId'])
@Index(['userId', 'type'])
export class FavoritePlace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  name: string; // Nom du lieu (ex: "Domicile", "Bureau", "Maison")

  @Column()
  address: string; // Adresse complète

  @Index('IDX_favorite_places_location', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  location: Point; // Coordonnées géographiques

  @Column({
    type: 'enum',
    enum: FavoritePlaceType,
    default: FavoritePlaceType.OTHER,
  })
  type: FavoritePlaceType;

  @Column({ default: false })
  isDefault: boolean; // Si c'est le lieu par défaut pour ce type

  @Column({ type: 'varchar', nullable: true })
  placeId: string | null; // Place ID de Google Maps (optionnel)

  @Column({ type: 'text', nullable: true })
  notes: string | null; // Notes/reperes utiles pour retrouver le lieu

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

