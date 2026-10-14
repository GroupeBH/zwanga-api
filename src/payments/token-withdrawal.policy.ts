import { ForbiddenException } from '@nestjs/common';
import { PaymentPurpose } from './entities/payment-transaction.entity';
import { REFERRAL_MIN_WITHDRAWAL_CDF } from '../wallet/token-value.policy';

export const TOKEN_WITHDRAWAL_DISABLED = {
  code: 'TOKEN_WITHDRAWALS_DISABLED',
  message:
    'Ces jetons Zwanga ne sont pas retirables en argent. Seuls les gains de trajets et les retraits de parrainage à partir de 1 000 jetons sont autorisés.',
} as const;

/** Business policy, not an environment switch. Applies only to NEW payouts.
 * Status checks and settlement of already submitted payments must keep running.
 */
export function assertPayoutPurposeAllowed(input: {
  purpose?: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  amount?: number;
  currency?: string;
}): void {
  const purpose = input.purpose || PaymentPurpose.DRIVER_PAYOUT;
  if (
    purpose === PaymentPurpose.REFERRAL_PAYOUT &&
    input.relatedEntityType === 'referral_withdrawal' &&
    input.relatedEntityId &&
    input.currency?.toUpperCase() === 'CDF' &&
    Number.isFinite(input.amount) &&
    input.amount! >= REFERRAL_MIN_WITHDRAWAL_CDF
  ) {
    return;
  }
  if (
    purpose !== PaymentPurpose.DRIVER_PAYOUT ||
    (input.relatedEntityType && input.relatedEntityType !== 'driver_payout')
  ) {
    throw new ForbiddenException(TOKEN_WITHDRAWAL_DISABLED);
  }
}
