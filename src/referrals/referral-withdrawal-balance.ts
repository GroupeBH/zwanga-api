import { BadRequestException } from '@nestjs/common';
import {
  REFERRAL_MIN_WITHDRAWAL_TOKENS,
  REFERRAL_MIN_WITHDRAWAL_CDF,
} from '../wallet/token-value.policy';

/** Also validate internal callers: never round a withdrawal into eligibility. */
export function validateReferralWithdrawalTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens < REFERRAL_MIN_WITHDRAWAL_TOKENS) {
    throw new BadRequestException(
      `Le retrait minimum est de ${REFERRAL_MIN_WITHDRAWAL_TOKENS} jetons de parrainage (${REFERRAL_MIN_WITHDRAWAL_CDF.toLocaleString('fr-FR')} FC)`,
    );
  }
  const cents = Math.round(tokens * 100);
  if (!Number.isSafeInteger(cents) || cents / 100 !== tokens) {
    throw new BadRequestException(
      'Le montant du retrait doit être un nombre valide avec au maximum deux décimales',
    );
  }
  return tokens;
}

function balanceCents(value: number | string): number {
  const number = Number(value);
  const cents = Math.round(number * 100);
  if (
    !['number', 'string'].includes(typeof value) ||
    (typeof value === 'string' && !value.trim()) ||
    !Number.isFinite(number) ||
    number < 0 ||
    !Number.isSafeInteger(cents) ||
    cents / 100 !== number
  ) {
    throw new BadRequestException(
      'Solde de parrainage invalide. Contactez le support avant tout retrait.',
    );
  }
  return cents;
}

/** Call only with the locked referral account, never a client-provided balance.
 * Pending, previously withdrawn and ordinary wallet tokens are not funding.
 */
export function reserveAvailableReferralTokens(
  account: { availableTokens: number | string; reservedTokens: number | string },
  tokens: number,
): { availableTokens: number; reservedTokens: number } {
  const requested = Math.round(validateReferralWithdrawalTokens(tokens) * 100);
  const available = balanceCents(account.availableTokens);
  const reserved = balanceCents(account.reservedTokens);
  if (requested > available) {
    throw new BadRequestException(
      'Solde de jetons de parrainage disponibles insuffisant pour ce retrait',
    );
  }
  if (!Number.isSafeInteger(reserved + requested)) {
    throw new BadRequestException('Solde de parrainage réservé invalide');
  }
  return {
    availableTokens: (available - requested) / 100,
    reservedTokens: (reserved + requested) / 100,
  };
}
