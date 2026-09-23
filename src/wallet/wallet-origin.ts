import { BadRequestException } from '@nestjs/common';

export const tokenCents = (value: number | string): number => {
  const number = Number(value);
  const cents = Math.round(number * 100);
  if (!Number.isFinite(number) || !Number.isSafeInteger(cents)) {
    throw new BadRequestException('Montant de jetons invalide');
  }
  return cents;
};

/** Mutates a locked account. Returns the signed purchased-token allocation. */
export function applyTokenMovement(
  account: {
    balance: number;
    withdrawableBalance?: number;
    withdrawalsBlocked?: boolean;
  },
  amount: number,
  purchasedCredit = 0,
  purchasedOnly = false,
): number {
  const total = tokenCents(account.balance);
  const purchased = tokenCents(account.withdrawableBalance ?? 0);
  const delta = tokenCents(amount);
  let purchasedDelta = tokenCents(purchasedCredit);
  if (purchased < 0 || purchased > total || delta === 0) {
    throw new BadRequestException('Solde de jetons incohérent');
  }
  if (delta < 0) {
    if (account.withdrawalsBlocked) {
      throw new BadRequestException(
        'Votre portefeuille nécessite une vérification. Contactez le support.',
      );
    }
    if (total + delta < 0 || (purchasedOnly && purchased + delta < 0)) {
      throw new BadRequestException(
        purchasedOnly
          ? 'Solde de jetons retirables insuffisant. Les jetons de fidélité ne sont pas retirables.'
          : 'Solde de jetons insuffisant',
      );
    }
    // Spend rewards first, except when explicitly reserving a cash withdrawal.
    purchasedDelta = purchasedOnly
      ? delta
      : -Math.max(0, -delta - (total - purchased));
  } else if (purchasedDelta < 0 || purchasedDelta > delta) {
    throw new BadRequestException('Origine des jetons incohérente');
  }
  account.balance = (total + delta) / 100;
  account.withdrawableBalance = (purchased + purchasedDelta) / 100;
  return purchasedDelta === 0 ? 0 : purchasedDelta / 100;
}

/** Refund purchased tokens first, without ever restoring more than originally spent. */
export function refundablePurchasedTokens(
  debit: { amount: number; withdrawableAmount: number | null },
  priorRefunds: { amount: number; withdrawableAmount: number | null }[],
  refund: number,
): number {
  const remaining =
    Math.abs(tokenCents(debit.amount)) -
    priorRefunds.reduce((sum, entry) => sum + tokenCents(entry.amount), 0);
  if (tokenCents(refund) > remaining) {
    throw new BadRequestException(
      'Le remboursement dépasse les jetons débités',
    );
  }
  const purchased =
    Math.abs(tokenCents(debit.withdrawableAmount ?? 0)) -
    priorRefunds.reduce(
      (sum, entry) => sum + tokenCents(entry.withdrawableAmount ?? 0),
      0,
    );
  return Math.max(0, Math.min(tokenCents(refund), purchased)) / 100;
}
