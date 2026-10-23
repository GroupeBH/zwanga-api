import {
  DriverPayout,
  DriverPayoutStatus,
} from './entities/driver-payout.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { PAYOUT_RELEASE_GRACE_MS, payoutRecoveryActions } from '../payments/payout-recovery-actions';

export const PAYOUT_RECOVERY_GRACE_MS = PAYOUT_RELEASE_GRACE_MS;
export const DEFAULT_PAYOUT_REVIEW_AFTER_MINUTES = 24 * 60;

export function payoutReviewDelay(value: unknown): number {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 15 && minutes <= 30 * 24 * 60
    ? minutes
    : DEFAULT_PAYOUT_REVIEW_AFTER_MINUTES;
}

export function payoutRecoveryState(
  payout: DriverPayout,
  payment: PaymentTransaction | null,
  reviewAfterMinutes: number,
  now = Date.now(),
) {
  const pending = [
    DriverPayoutStatus.PENDING,
    DriverPayoutStatus.INITIATED,
  ].includes(payout.status);
  const since = new Date(payout.requestedAt ?? payout.createdAt).getTime();
  const isStale =
    pending &&
    Number.isFinite(since) &&
    now - since >= reviewAfterMinutes * 60_000;
  const reviewOpen = Boolean(
    payout.reviewRequestedAt && !payout.reviewResolvedAt,
  );
  return {
    ...payoutRecoveryActions(payout, payment, now),
    isStale,
    requiresReview: Boolean(
      payout.recoveryBlocked ||
      (pending && (isStale || reviewOpen || !payment?.orderNumber)),
    ),
    canRequestReview: pending && !reviewOpen,
    canCheckStatus: pending,
    canRetry:
      !payout.recoveryBlocked &&
      [DriverPayoutStatus.FAILED, DriverPayoutStatus.CANCELLED].includes(
        payout.status,
      ),
    reviewStatus: payout.recoveryBlocked
      ? 'blocked'
      : reviewOpen
        ? 'requested'
        : payout.reviewResolvedAt
          ? 'resolved'
          : 'none',
  };
}
