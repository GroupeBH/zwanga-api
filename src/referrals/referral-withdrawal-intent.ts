import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ReferralWithdrawal } from './entities/referral-withdrawal.entity';

export function referralWithdrawalPhone(phone: string): string {
  const normalized = phone.trim().replace(/^\+/, '');
  if (!/^243\d{9}$/.test(normalized)) throw new BadRequestException('Un numéro Mobile Money RDC valide est requis (243 suivi de 9 chiffres).');
  return normalized;
}

export function referralWithdrawalKey(key?: string): string | null {
  if (key === undefined) return null;
  if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
    throw new BadRequestException('La clé de reprise doit être un UUID valide.');
  return key.toLowerCase();
}

export function assertSameReferralIntent(existing: ReferralWithdrawal, tokens: number, phone: string): void {
  if (Number(existing.tokens) !== tokens || existing.phone.replace(/^\+/, '') !== phone)
    throw new ConflictException({ code: 'REFERRAL_WITHDRAWAL_INTENT_CONFLICT', message: 'Une demande existe déjà avec des paramètres différents. Consultez son statut.', withdrawalId: existing.id });
}
