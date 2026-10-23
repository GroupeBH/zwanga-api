import { BadGatewayException, BadRequestException } from '@nestjs/common';
import {
  PaymentProvider,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

export const PAYOUT_RELEASE_GRACE_MS = 15 * 60_000;

/** Definitive out-of-band proof may be used during a provider outage, never
 * to bypass an identity/reference/amount mismatch reported by reconciliation. */
export function isPayoutRecoveryCheckUnavailable(error: unknown): boolean {
  if (error instanceof BadGatewayException) return true;
  if (!(error instanceof BadRequestException)) return false;
  const response = error.getResponse();
  return (
    typeof response === 'object' &&
    'code' in response &&
    response.code === 'PAYOUT_SERVICE_UNAVAILABLE'
  );
}

/** Capabilities only, not authorization or proof that the provider cancelled a transfer. */
export function payoutRecoveryActions(
  payout: {
    id: string;
    status: string;
    requestedAt?: Date | null;
    createdAt: Date;
    paymentTransactionId?: string | null;
    recoveryBlocked?: boolean;
  },
  payment: PaymentTransaction | null | undefined,
  now = Date.now(),
) {
  const pending = ['pending', 'initiated'].includes(payout.status);
  const age = now - new Date(payout.requestedAt ?? payout.createdAt).getTime();
  const missingPayment = !!payout.paymentTransactionId && !payment;
  return {
    expectedReference: missingPayment
      ? null
      : (payment?.reference ?? payout.id),
    canResolveNotPaid:
      pending &&
      !payout.recoveryBlocked &&
      Number.isFinite(age) &&
      age >= PAYOUT_RELEASE_GRACE_MS &&
      !missingPayment &&
      (!payment || payment.provider === PaymentProvider.FLEXPAY) &&
      payment?.status !== PaymentStatus.SUCCEEDED,
    resolutionRequiresProviderConfirmation: true,
  };
}
