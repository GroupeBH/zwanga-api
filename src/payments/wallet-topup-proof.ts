import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const scalar = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Legacy local success alone is not evidence that cash-redeemable tokens were paid for. */
export function hasVerifiedWalletTopUpProof(
  payment: PaymentTransaction,
): boolean {
  const proof = record(payment.rawCheckResponse);
  const transaction = record(proof.transaction ?? proof.Transaction);
  const status = scalar(
    transaction.status ??
      transaction.Status ??
      transaction.code ??
      transaction.Code,
  );
  const amount = scalar(transaction.amount);
  const reference = scalar(transaction.reference);
  const expectedAmount = Number(payment.amount);
  return (
    payment.purpose === PaymentPurpose.WALLET_TOP_UP &&
    payment.status === PaymentStatus.SUCCEEDED &&
    payment.relatedEntityType === 'wallet_top_up' &&
    Boolean(payment.userId) &&
    payment.relatedEntityId === payment.userId &&
    scalar(proof.code ?? proof.Code) === '0' &&
    status === '0' &&
    Boolean(payment.orderNumber) &&
    scalar(transaction.orderNumber) === payment.orderNumber &&
    Boolean(reference) &&
    [payment.reference, payment.orderNumber].includes(reference) &&
    /^\d+(\.\d+)?$/.test(amount) &&
    Number.isFinite(expectedAmount) &&
    expectedAmount > 0 &&
    Number(amount) === expectedAmount &&
    Boolean(payment.currency) &&
    scalar(transaction.currency).toUpperCase() ===
      payment.currency.trim().toUpperCase()
  );
}
