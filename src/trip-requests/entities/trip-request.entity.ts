import type { Point } from 'typeorm';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { DriverOffer } from './driver-offer.entity';

export enum TripRequestStatus {
  PENDING = 'pending', // En attente d'offres
  OFFERS_RECEIVED = 'offers_received', // Des offres ont été reçues
  DRIVER_SELECTED = 'driver_selected', // Un driver a été sélectionné
  CANCELLED = 'cancelled', // Annulé par le passager
  EXPIRED = 'expired', // Expiré (délai dépassé)
}

@Entity('trip_requests')
@Index(['departureLocation'])
@Index(['arrivalLocation'])
@Index(['departureDateMin'])
@Index(['departureDateMax'])
export class TripRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  passengerId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'passengerId' })
  passenger: User;

  @Column()
  departureLocation: string;

  @Index('IDX_trip_requests_departure_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  departurePoint: Point;

  @Column()
  arrivalLocation: string;

  @Index('IDX_trip_requests_arrival_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  arrivalPoint: Point;

  @Column({ type: 'timestamp' })
  departureDateMin: Date; // Date/heure de départ minimum souhaitée

  @Column({ type: 'timestamp' })
  departureDateMax: Date; // Date/heure de départ maximum acceptée (délai)

  @Column({ type: 'int' })
  numberOfSeats: number; // Nombre de places nécessaires

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  maxPricePerSeat: number | null; // Prix maximum par place accepté (optionnel)

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: TripRequestStatus,
    default: TripRequestStatus.PENDING,
  })
  status: TripRequestStatus;

  @Column({ nullable: true })
  selectedDriverId: string | null; // Driver sélectionné par le passager

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'selectedDriverId' })
  selectedDriver: User | null;

  @Column({ nullable: true })
  selectedVehicleId: string | null; // Véhicule du driver sélectionné

  @ManyToOne(() => Vehicle, { nullable: true })
  @JoinColumn({ name: 'selectedVehicleId' })
  selectedVehicle: Vehicle | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  selectedPricePerSeat: number | null; // Prix accepté pour le driver sélectionné

  @Column({ type: 'timestamp', nullable: true })
  selectedAt: Date | null; // Date de sélection du driver

  @Column({ type: 'boolean', default: false })
  expirationNotificationSent: boolean; // Si une notification d'expiration a été envoyée

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => DriverOffer, (offer) => offer.tripRequest)
  driverOffers: DriverOffer[];
}

