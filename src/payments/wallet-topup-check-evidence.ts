import { BadRequestException } from '@nestjs/common';
import {
  PaymentPurpose,
  type PaymentTransaction,
} from './entities/payment-transaction.entity';
import type { FlexPayTransactionStatus } from './flexpay.service';

/** Only a successful credit needs complete proof. Other states still require correlation. */
export function assertWalletTopUpCheckEvidence(
  payment: PaymentTransaction,
  provider: FlexPayTransactionStatus,
  outcome: 'succeeded' | 'failed' | 'pending',
): void {
  if (payment.purpose !== String(PaymentPurpose.WALLET_TOP_UP)) return;
  if (outcome !== 'succeeded') {
    const expectedOrder = payment.orderNumber?.trim();
    const expectedReference = payment.reference?.trim();
    const order = provider.orderNumber?.trim();
    const reference = provider.reference?.trim();
    const referenceMatches = Boolean(
      reference &&
      (reference === expectedOrder || reference === expectedReference),
    );
    const orderMatches = Boolean(order && order === expectedOrder);
    if (
      !expectedOrder ||
      (!referenceMatches && !orderMatches) ||
      (order && !orderMatches) ||
      (reference && !referenceMatches)
    ) {
      throw new BadRequestException(
        'La réponse FlexPay ne correspond pas à cette recharge',
      );
    }
    // Supplied amounts/currencies are still checked by PaymentsService.
    // Pending is not a refusal, a successful payment or permission to credit tokens.
    return;
  }
  if (
    !provider.reference?.trim() ||
    !provider.orderNumber?.trim() ||
    provider.orderNumber.trim() !== payment.orderNumber ||
    provider.amount == null ||
    !provider.currency?.trim()
  ) {
    throw new BadRequestException(
      'La recharge nécessite une confirmation FlexPay complète du montant et de la devise',
    );
  }
}
