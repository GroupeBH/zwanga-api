import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PawaPayRefundStatus {
  CREATED = 'created',
  INITIATED = 'initiated',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('pawapay_refunds')
@Index('IDX_pawapay_refunds_payment_created', [
  'paymentTransactionId',
  'createdAt',
])
@Index('IDX_pawapay_refunds_pending', ['updatedAt'], {
  where: "\"status\" IN ('created', 'initiated')",
})
export class PawaPayRefund {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'uuid' })
  paymentTransactionId: string;

  @Column({ type: 'uuid' })
  createdByUserId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 8 })
  currency: string;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  businessReversalReference: string | null;

  @Column({ type: 'varchar', length: 20, default: PawaPayRefundStatus.CREATED })
  status: PawaPayRefundStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  providerStatusCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  providerMessage: string | null;

  @Column({ type: 'jsonb', nullable: true })
  rawInitiationResponse: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  rawCheckResponse: Record<string, unknown> | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
