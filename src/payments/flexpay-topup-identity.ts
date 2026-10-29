import type { PaymentTransaction } from './entities/payment-transaction.entity';

const identifier = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Correlation of a server-side FlexPay check, not proof of payment by itself. */
export function hasMatchingFlexPayTopUpIdentity(
  payment: Pick<PaymentTransaction, 'orderNumber' | 'reference'>,
  provider: { orderNumber?: unknown; reference?: unknown },
): boolean {
  const expectedOrder = payment.orderNumber?.trim();
  const reference = identifier(provider.reference);
  if (!expectedOrder || !reference) return false;

  // Some check responses only echo the provider order in `reference`.
  // A merchant reference alone is insufficient when the provider order is absent.
  if (provider.orderNumber == null) return reference === expectedOrder;

  // An explicit conflicting (or empty/malformed) order must never use the fallback.
  return (
    identifier(provider.orderNumber) === expectedOrder &&
    (reference === expectedOrder || reference === payment.reference?.trim())
  );
}
