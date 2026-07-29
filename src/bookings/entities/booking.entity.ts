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
import { Trip } from '../../trips/entities/trip.entity';
import { Message } from '../../chat/entities/message.entity';
import { PaymentTransaction } from '../../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../../payments/enums/trip-payment-mode.enum';
import {
  DriverTripInterruptionConfirmation,
  DriverTripInterruptionRequest,
  PassengerTripInterruptionRequest,
} from '../../trips/entities/trip-interruption.entity';

export enum BookingStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

export enum BookingPaymentStatus {
  NOT_REQUIRED = 'not_required',
  PENDING = 'pending',
  INITIATED = 'initiated',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('bookings')
@Index(['tripId', 'passengerId'])
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tripId: string;

  @ManyToOne(() => Trip, (trip) => trip.bookings)
  @JoinColumn({ name: 'tripId' })
  trip: Trip;

  @Column()
  passengerId: string;

  @ManyToOne(() => User, (user) => user.bookings)
  @JoinColumn({ name: 'passengerId' })
  passenger: User;

  @Column({ type: 'int', default: 1 })
  numberOfSeats: number;

  @Column({ type: 'varchar', nullable: true })
  passengerOrigin: string | null;

  @Column({ type: 'text', nullable: true })
  passengerOriginReference: string | null;

  @Index('IDX_bookings_passenger_origin_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  passengerOriginPoint: Point | null;

  @Column({ type: 'varchar', nullable: true })
  passengerDestination: string | null;

  @Column({ type: 'text', nullable: true })
  passengerDestinationReference: string | null;

  @Index('IDX_bookings_passenger_destination_point', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  passengerDestinationPoint: Point | null;

  @Index('IDX_bookings_passenger_current_location', { spatial: true })
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  passengerCurrentLocation: Point | null; // Position actuelle du passager

  @Column({ type: 'timestamp', nullable: true })
  passengerLastLocationUpdateAt: Date | null; // Dernière mise à jour de position

  @Column({ type: 'boolean', default: false })
  destinationProximityNotified: boolean; // Indique si la notification de proximité a été envoyée

  @Column({ type: 'timestamp', nullable: true })
  passengerDestinationApproachNotifiedAt: Date | null; // Modal temps reel envoye quand le vehicule approche de la destination passager

  @Column({ type: 'timestamp', nullable: true })
  driverPickupArrivedAt: Date | null; // Conducteur detecte au point de prise en charge

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING,
  })
  status: BookingStatus;

  @Column({
    type: 'enum',
    enum: BookingPaymentStatus,
    enumName: 'bookings_payment_status_enum',
    default: BookingPaymentStatus.NOT_REQUIRED,
  })
  paymentStatus: BookingPaymentStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  paymentAmount: number | null;

  @Column({ type: 'varchar', length: 8, default: 'CDF' })
  paymentCurrency: string;

  @Column({ type: 'varchar', length: 30, default: TripPaymentMode.CASH })
  paymentMode: TripPaymentMode;

  @Index()
  @Column({ type: 'varchar', length: 120, nullable: true })
  paymentReference: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  paymentTransactionId: string | null;

  @ManyToOne(() => PaymentTransaction, { nullable: true })
  @JoinColumn({ name: 'paymentTransactionId' })
  paymentTransaction: PaymentTransaction | null;

  @Column({ type: 'timestamp', nullable: true })
  paidAt: Date | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'boolean', default: false })
  pickedUp: boolean; // Driver a confirmé la récupération

  @Column({ type: 'timestamp', nullable: true })
  pickedUpAt: Date | null; // Date de récupération confirmée par le driver

  @Column({ type: 'boolean', default: false })
  pickedUpConfirmedByPassenger: boolean; // Passager a confirmé la récupération

  @Column({ type: 'timestamp', nullable: true })
  pickedUpConfirmedAt: Date | null; // Date de confirmation par le passager

  @Column({ type: 'boolean', default: false })
  droppedOff: boolean; // Conducteur a confirmé l'arrivée

  @Column({ type: 'timestamp', nullable: true })
  droppedOffAt: Date | null; // Date d'arrivée confirmée par le conducteur

  @Column({ type: 'boolean', default: false })
  droppedOffConfirmedByPassenger: boolean; // Passager a signalé son arrivée

  @Column({ type: 'timestamp', nullable: true })
  droppedOffConfirmedAt: Date | null; // Date du signalement d'arrivée par le passager

  @Column({ type: 'jsonb', default: () => "'[]'" })
  safetyEmergencyContactIds: string[]; // Contacts d'urgence choisis pour les notifications WhatsApp

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Message, (message) => message.booking)
  messages: Message[];

  @OneToMany(
    () => PassengerTripInterruptionRequest,
    (request) => request.booking,
  )
  interruptionRequests: PassengerTripInterruptionRequest[];

  @OneToMany(
    () => DriverTripInterruptionConfirmation,
    (confirmation) => confirmation.booking,
  )
  tripInterruptionConfirmations: DriverTripInterruptionConfirmation[];

  interruptionRequest?: PassengerTripInterruptionRequest | null;
  tripInterruptionRequest?: DriverTripInterruptionRequest | null;
}
