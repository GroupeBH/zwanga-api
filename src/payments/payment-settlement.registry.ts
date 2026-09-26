import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

export type PaymentSettlementHandler = (
  payment: PaymentTransaction,
) => Promise<unknown>;

@Injectable()
export class PaymentSettlementRegistry {
  private readonly logger = new Logger(PaymentSettlementRegistry.name);
  private readonly handlers = new Map<string, PaymentSettlementHandler>();

  register(purpose: string, handler: PaymentSettlementHandler): void {
    this.handlers.set(purpose, handler);
  }

  async apply(payment: PaymentTransaction): Promise<void> {
    if (
      ![
        PaymentStatus.SUCCEEDED,
        PaymentStatus.FAILED,
        PaymentStatus.CANCELLED,
      ].includes(payment.status)
    )
      return;
    const handler = this.handlers.get(payment.purpose);
    if (!handler) {
      if (payment.purpose !== PaymentPurpose.GENERIC) {
        throw new ServiceUnavailableException(
          'Finalisation du paiement temporairement indisponible',
        );
      }
      this.logger.debug(
        `No settlement handler for purpose=${payment.purpose}, paymentId=${payment.id}`,
      );
      return;
    }

    await handler(payment);
  }
}
