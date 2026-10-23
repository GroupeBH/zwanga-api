import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { claimTopUpPayment } from './topup-payment-claim';

/** Reserve the original key before declaring an unsent top-up cancelled.
 * The unique reference arbitrates against an initiation arriving late: only
 * the winning initiation may contact the provider. No HTTP under a DB lock.
 */
export async function recoverTopUpClaim(
  repository: Repository<PaymentTransaction>,
  cancelled: PaymentTransaction,
): Promise<PaymentTransaction> {
  const existing = await repository.findOne({
    where: { reference: cancelled.reference },
  });
  if (existing) {
    // Compare purchased tokens, not today's exchange rate for an older payment.
    if (
      existing.userId !== cancelled.userId ||
      existing.purpose !== String(PaymentPurpose.WALLET_TOP_UP) ||
      existing.method !== cancelled.method ||
      existing.phone !== cancelled.phone ||
      Number(existing.tokenQuantity) !== Number(cancelled.tokenQuantity)
    ) {
      throw new ConflictException(
        'Cette recharge ne correspond pas à la tentative à vérifier.',
      );
    }
    return existing;
  }
  cancelled.status = PaymentStatus.CANCELLED;
  return (await claimTopUpPayment(repository, cancelled)).payment;
}
