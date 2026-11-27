import { BadRequestException } from '@nestjs/common';
import type { PaymentTransaction } from './entities/payment-transaction.entity';
import type { FlexPayTransactionStatus } from './flexpay.service';
import { hasMatchingFlexPayTopUpIdentity } from './flexpay-topup-identity';

/** A callback is a wake-up signal, never the authority that binds an order. */
export function assertFlexPayDepositCallbackIdentity(
  payment: Pick<PaymentTransaction, 'reference' | 'orderNumber'>,
  callback: { reference: string; orderNumber?: string | null },
): void {
  if (
    !payment.orderNumber ||
    callback.reference !== payment.reference ||
    (callback.orderNumber != null &&
      callback.orderNumber !== payment.orderNumber)
  ) {
    throw new BadRequestException(
      'La notification ne correspond pas à une commande FlexPay enregistrée',
    );
  }
}

export function assertFlexPayDepositEvidence(
  payment: PaymentTransaction,
  provider: FlexPayTransactionStatus,
  succeeded: boolean,
): void {
  if (!hasMatchingFlexPayTopUpIdentity(payment, provider)) {
    throw new BadRequestException(
      'La preuve FlexPay ne correspond pas à la commande enregistrée',
    );
  }
  if (!succeeded) return;
  const amount = String(provider.amount ?? '').trim();
  if (
    !/^\d+(\.\d+)?$/.test(amount) ||
    !Number.isFinite(Number(payment.amount)) ||
    Number(payment.amount) <= 0 ||
    Number(amount) !== Number(payment.amount) ||
    !provider.currency ||
    provider.currency.trim().toUpperCase() !==
      payment.currency?.trim().toUpperCase()
  ) {
    throw new BadRequestException(
      'Montant ou devise FlexPay absent ou incompatible',
    );
  }
}
