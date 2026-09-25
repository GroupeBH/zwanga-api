import { BadRequestException } from '@nestjs/common';
const DRC_COUNTRY_CODE = '243';

const DRC_PROVIDER_PREFIXES: Array<{
  provider: string;
  prefixes: string[];
}> = [
  { provider: 'VODACOM_MPESA_COD', prefixes: ['81', '82', '83'] },
  { provider: 'ORANGE_COD', prefixes: ['80', '84', '85', '89', '90'] },
  { provider: 'AIRTEL_COD', prefixes: ['97', '98', '99'] },
];

export function toPawaPayMsisdn(phone: string): string {
  if (!/^[+\d\s()-]+$/.test(phone)) {
    throw new BadRequestException('Numéro Mobile Money invalide');
  }
  const digits = phone
    .trim()
    .replace(/[\s()-]/g, '')
    .replace(/^\+/, '');
  if (digits.startsWith('00')) {
    return toPawaPayMsisdn(digits.slice(2));
  }
  if (digits.startsWith(DRC_COUNTRY_CODE) && digits.length === 12) {
    return digits;
  }
  if (digits.length === 9 && /^[89]/.test(digits)) {
    return `${DRC_COUNTRY_CODE}${digits}`;
  }
  if (digits.length === 10 && digits.startsWith('0')) {
    return `${DRC_COUNTRY_CODE}${digits.slice(1)}`;
  }
  throw new BadRequestException(
    'Le numéro Mobile Money doit être un numéro de RDC valide (+243)',
  );
}

export function predictPawaPayProvider(
  phone: string,
  fallback?: string | null,
): string {
  const msisdn = toPawaPayMsisdn(phone);
  if (msisdn.startsWith(DRC_COUNTRY_CODE) && msisdn.length === 12) {
    const nationalPrefix = msisdn.slice(3, 5);
    const match = DRC_PROVIDER_PREFIXES.find((entry) =>
      entry.prefixes.includes(nationalPrefix),
    );
    if (match) {
      return match.provider;
    }
  }

  const configured = fallback?.trim();
  if (
    configured &&
    DRC_PROVIDER_PREFIXES.some((entry) => entry.provider === configured)
  ) {
    return configured;
  }

  throw new BadRequestException(
    "Impossible de déterminer l'opérateur Mobile Money PawaPay pour ce numéro",
  );
}

export function toPawaPayCustomerMessage(description?: string | null): string {
  const sanitized = (description ?? 'ZWANGA PAY')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 22)
    .trim();

  return sanitized.length >= 4 ? sanitized : 'ZWANGA PAY';
}

export function formatPawaPayAmount(
  amount: number,
  currency: string,
  provider?: string,
): string {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!['CDF', 'USD'].includes(normalizedCurrency)) {
    throw new BadRequestException(
      'Devise PawaPay non prise en charge pour la RDC',
    );
  }
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 99_999_999.99 ||
    Number(amount.toFixed(2)) !== amount
  ) {
    throw new BadRequestException(
      'Montant invalide : deux décimales au maximum',
    );
  }
  if (
    normalizedCurrency === 'CDF' &&
    provider === 'VODACOM_MPESA_COD' &&
    !Number.isInteger(amount)
  ) {
    throw new BadRequestException(
      'Vodacom exige un montant entier en CDF. Choisissez un autre moyen de paiement ou un montant entier.',
    );
  }
  // PawaPay forbids trailing fractional zeroes; never change the ledger amount.
  return String(amount);
}
