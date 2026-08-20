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
import { Vehicle, VehicleType } from '../../vehicles/entities/vehicle.entity';
import { DriverOffer } from './driver-offer.entity';
import { TripPaymentMode } from '../../payments/enums/trip-payment-mode.enum';

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
@Index('IDX_trip_requests_vehicle_type', ['vehicleType'])
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

  @Column({ type: 'text', nullable: true })
  departureReference: string | null;

  @Index('IDX_trip_requests_departure_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  departurePoint: Point | null;

  @Column()
  arrivalLocation: string;

  @Column({ type: 'text', nullable: true })
  arrivalReference: string | null;

  @Index('IDX_trip_requests_arrival_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  arrivalPoint: Point | null;

  @Column({ type: 'timestamp' })
  departureDateMin: Date; // Date/heure de départ minimum souhaitée

  @Column({ type: 'timestamp' })
  departureDateMax: Date; // Fin de la plage de départ, utilisée comme référence pour l'expiration

  @Column({ type: 'int' })
  numberOfSeats: number; // Nombre de places nécessaires (1 si omis à la création)

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  maxPricePerSeat: number | null; // Prix maximum par place accepté (optionnel)

  @Column({
    type: 'enum',
    enum: VehicleType,
    enumName: 'vehicles_type_enum',
    default: VehicleType.CAR,
  })
  vehicleType: VehicleType; // Type de véhicule explicitement choisi par le passager

  @Column({ type: 'varchar', length: 30, default: TripPaymentMode.CASH })
  paymentMode: TripPaymentMode;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: TripRequestStatus,
    default: TripRequestStatus.PENDING,
  })
  status: TripRequestStatus;

  @Column({ type: 'varchar', nullable: true })
  selectedDriverId: string | null; // Driver sélectionné par le passager

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'selectedDriverId' })
  selectedDriver: User | null;

  @Column({ type: 'varchar', nullable: true })
  selectedVehicleId: string | null; // Véhicule du driver sélectionné

  @ManyToOne(() => Vehicle, { nullable: true })
  @JoinColumn({ name: 'selectedVehicleId' })
  selectedVehicle: Vehicle | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  selectedPricePerSeat: number | null; // Prix accepté pour le driver sélectionné

  @Column({ type: 'timestamp', nullable: true })
  selectedAt: Date | null; // Date de sélection du driver

  @Column({ type: 'varchar', nullable: true })
  tripId: string | null; // ID du trip créé à partir de cette demande

  @Column({ type: 'boolean', default: false })
  expirationNotificationSent: boolean; // Notification du délai de douze heures envoyée

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => DriverOffer, (offer) => offer.tripRequest)
  driverOffers: DriverOffer[];
}
