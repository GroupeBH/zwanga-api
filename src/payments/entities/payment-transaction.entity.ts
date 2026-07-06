import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentProvider {
  FLEXPAY = 'flexpay',
}

export enum PaymentMethod {
  MOBILE_MONEY = 'mobile_money',
  CARD = 'card',
}

export enum PaymentStatus {
  PENDING = 'pending',
  INITIATED = 'initiated',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum PaymentPurpose {
  GENERIC = 'generic',
  SUBSCRIPTION_PRO = 'subscription_pro',
  TRIP_BOOKING = 'trip_booking',
  WALLET_TOP_UP = 'wallet_top_up',
  DRIVER_PAYOUT = 'driver_payout',
}

@Entity('payment_transactions')
@Index(['userId', 'status'])
@Index(['purpose', 'relatedEntityType', 'relatedEntityId'])
export class PaymentTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 80, default: PaymentPurpose.GENERIC })
  purpose: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  relatedEntityType: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  relatedEntityId: string | null;

  @Column({
    type: 'enum',
    enum: PaymentProvider,
    default: PaymentProvider.FLEXPAY,
  })
  provider: PaymentProvider;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
  })
  method: PaymentMethod;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 120 })
  reference: string;

  @Index()
  @Column({ type: 'varchar', length: 120, nullable: true })
  orderNumber: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  providerReference: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  providerStatusCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  providerMessage: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 8 })
  currency: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  paymentUrl: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  callbackUrl: string | null;

  @Column({ type: 'jsonb', nullable: true })
  rawInitiationResponse: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  rawCallbackPayload: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  rawCheckResponse: Record<string, unknown> | null;

  @Column({ type: 'timestamp', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
