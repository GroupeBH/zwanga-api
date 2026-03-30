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
import { Vehicle } from '../../vehicles/entities/vehicle.entity';
import { TripRequest } from './trip-request.entity';

export enum DriverOfferStatus {
  PENDING = 'pending', // En attente de réponse
  ACCEPTED = 'accepted', // Accepté par le passager
  REJECTED = 'rejected', // Rejeté par le passager
  CANCELLED = 'cancelled', // Annulé par le driver
}

@Entity('driver_offers')
@Index(['tripRequestId', 'driverId'])
export class DriverOffer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tripRequestId: string;

  @ManyToOne(() => TripRequest, (tripRequest) => tripRequest.driverOffers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tripRequestId' })
  tripRequest: TripRequest;

  @Column()
  driverId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'driverId' })
  driver: User;

  @Column({ type: 'varchar', nullable: true })
  vehicleId: string | null;

  @ManyToOne(() => Vehicle, { nullable: true })
  @JoinColumn({ name: 'vehicleId' })
  vehicle: Vehicle | null;

  @Column({ type: 'timestamp' })
  proposedDepartureDate: Date; // Date/heure de départ proposée par le driver

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  pricePerSeat: number; // Prix proposé par place

  @Column({ type: 'int' })
  availableSeats: number; // Nombre de places disponibles

  @Column({ type: 'text', nullable: true })
  message: string | null; // Message optionnel du driver

  @Column({
    type: 'enum',
    enum: DriverOfferStatus,
    default: DriverOfferStatus.PENDING,
  })
  status: DriverOfferStatus;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  rejectedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

