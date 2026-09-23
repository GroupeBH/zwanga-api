import { BadRequestException } from '@nestjs/common';
import { isAxiosError } from 'axios';

export function normalizePayoutPhone(phone: string): string {
  let digits = phone.trim().replace(/[\s()-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00243')) digits = digits.slice(2);
  else if (/^0\d{9}$/.test(digits)) digits = `243${digits.slice(1)}`;
  else if (/^[89]\d{8}$/.test(digits)) digits = `243${digits}`;
  if (!/^243\d{9}$/.test(digits)) {
    throw new BadRequestException({
      code: 'PAYOUT_PHONE_INVALID',
      message:
        'Le numéro Mobile Money est invalide. Vérifiez le numéro de votre profil (par exemple 0891234567).',
    });
  }
  return `+${digits}`;
}

export const PAYOUT_MESSAGES = {
  configuration:
    'Le service de versement Zwanga est indisponible. Contactez l’assistance si le problème persiste.',
  funds:
    'Zwanga ne peut pas effectuer ce versement pour le moment. Vos gains sont conservés. Contactez l’assistance.',
  refused:
    'Le versement a été refusé. Vérifiez que le numéro de votre profil possède un compte Mobile Money actif, ou contactez l’assistance.',
  pending:
    'Zwanga vérifie le versement de vos gains vers votre Mobile Money. Aucun paiement ne vous est demandé.',
  review:
    'La confirmation du versement n’est pas encore disponible. Vos gains restent réservés pour éviter un double versement. Contactez l’assistance avec la référence de ce versement.',
};

export function getPayoutFailureMessage(
  raw?: string | null,
  status?: string | null,
): string {
  const normalizedStatus = status?.toUpperCase().replace(/^OXX/, '0XX');
  if (normalizedStatus === '0XX2') return PAYOUT_MESSAGES.funds;
  if (normalizedStatus === '0XX4') return PAYOUT_MESSAGES.configuration;
  if (raw && Object.values(PAYOUT_MESSAGES).includes(raw)) return raw;
  const message = (raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/solde|insufficient|insuffisant|balance/.test(message))
    return PAYOUT_MESSAGES.funds;
  if (/token|merchant|marchand|unauthoriz|forbidden|configur/.test(message))
    return PAYOUT_MESSAGES.configuration;
  if (
    /numero|phone|telephone/.test(message) &&
    /invalid|incomplet/.test(message)
  ) {
    return 'Le numéro Mobile Money est invalide. Vérifiez le numéro de votre profil.';
  }
  return PAYOUT_MESSAGES.refused;
}

export function assertPayoutUrl(
  url: string,
  production: boolean,
  endpoint = false,
): string {
  try {
    const parsed = new URL(url);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (endpoint &&
        (!parsed.pathname.replace(/\/$/, '').endsWith('/pay') ||
          parsed.search ||
          parsed.hash)) ||
      (production &&
        (parsed.protocol !== 'https:' ||
          ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)))
    ) {
      throw new Error('Invalid payout URL');
    }
    return url;
  } catch {
    throw new BadRequestException({
      code: 'PAYOUT_SERVICE_UNAVAILABLE',
      message: PAYOUT_MESSAGES.configuration,
    });
  }
}

/** Only explicit request rejections are final. Timeouts and 5xx remain uncertain. */
export function getPayoutHttpRejection(
  error: unknown,
): BadRequestException | null {
  if (!isAxiosError(error)) return null;
  const status = error.response?.status;
  if (!status || ![400, 401, 403, 404, 405, 422].includes(status)) return null;
  const data = error.response?.data as
    { message?: unknown; Message?: unknown; status?: unknown } | undefined;
  const providerStatus = typeof data?.status === 'string' ? data.status : null;
  if (providerStatus?.toUpperCase().replace(/^OXX/, '0XX') === '0XX1')
    return null;
  const raw = data?.message ?? data?.Message;
  return new BadRequestException({
    code: [401, 403, 404, 405].includes(status)
      ? 'PAYOUT_SERVICE_UNAVAILABLE'
      : 'PAYOUT_REJECTED',
    message: [401, 403, 404, 405].includes(status)
      ? PAYOUT_MESSAGES.configuration
      : getPayoutFailureMessage(
          typeof raw === 'string' ? raw : null,
          providerStatus,
        ),
  });
}
