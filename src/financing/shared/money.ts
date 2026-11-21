import { BadRequestException } from '@nestjs/common';

export const MAX_MINOR = 1_000_000_000_000n;

/** CDF cents. Wallet precision is 0.01 token = 10 cents, never rounded up. */
export function minor(value: string, zero = true): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,12})$/.test(value))
    throw new BadRequestException('Montant entier en centimes de CDF attendu.');
  const amount = BigInt(value);
  if (amount > MAX_MINOR || (!zero && amount === 0n) || amount % 10n !== 0n)
    throw new BadRequestException(
      'Montant hors limites ou incompatible avec la précision du portefeuille.',
    );
  return amount;
}

export function floorWallet(amount: bigint) {
  return (amount / 10n) * 10n;
}

export function minimum(...values: bigint[]) {
  return values.reduce((a, b) => (a < b ? a : b));
}

export function cents(decimal: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(decimal))
    throw new BadRequestException('Montant comptable invalide.');
  const [whole, fraction = ''] = decimal.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function decimal(amount: bigint): string {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}
