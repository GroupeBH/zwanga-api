import { BadRequestException } from '@nestjs/common';
import {
  PaymentPurpose,
  type PaymentTransaction,
} from './entities/payment-transaction.entity';
import type { FlexPayTransactionStatus } from './flexpay.service';

/** A verified refusal needs correlation, not the full proof required to grant tokens. */
export function assertWalletTopUpCheckEvidence(
  payment: PaymentTransaction,
  provider: FlexPayTransactionStatus,
  confirmedFailure: boolean,
): void {
  if (payment.purpose !== String(PaymentPurpose.WALLET_TOP_UP)) return;
  if (confirmedFailure) {
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
        'Le refus FlexPay ne correspond pas à cette recharge',
      );
    }
    // Supplied amounts/currencies are still checked by PaymentsService.
    // This branch can never authorize a success or a wallet credit.
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
