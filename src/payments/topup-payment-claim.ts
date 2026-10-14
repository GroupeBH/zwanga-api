import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { PaymentTransaction } from './entities/payment-transaction.entity';

export function topUpReference(userId: string, key: string): string {
  // FlexPay accepts at most 25 alphanumeric characters (same budget as legacy references).
  return `WAL${createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 22).toUpperCase()}`;
}

/** The existing unique reference index arbitrates concurrent requests, before HTTP. */
export async function claimTopUpPayment(repository: Repository<PaymentTransaction>, candidate: PaymentTransaction) {
  try {
    return { payment: await repository.save(candidate), created: true };
  } catch (error) {
    if ((error as { code?: string; driverError?: { code?: string } })?.code !== '23505' &&
      (error as { driverError?: { code?: string } })?.driverError?.code !== '23505') throw error;
    const existing = await repository.findOne({ where: { reference: candidate.reference } });
    if (!existing) throw error;
    if (existing.userId !== candidate.userId || existing.purpose !== candidate.purpose ||
      existing.method !== candidate.method || existing.currency !== candidate.currency ||
      Math.round(Number(existing.amount) * 100) !== Math.round(Number(candidate.amount) * 100) ||
      existing.phone !== candidate.phone) {
      throw new ConflictException('Cette reference de recharge correspond deja a une autre operation.');
    }
    if (existing.tokenQuantity != null && candidate.tokenQuantity != null &&
      Math.round(Number(existing.tokenQuantity) * 100) !== Math.round(Number(candidate.tokenQuantity) * 100)) {
      throw new ConflictException('Cette reference de recharge correspond deja a une autre quantite de jetons.');
    }
    // Even pending/uncertain payments must never initiate a second provider debit.
    return { payment: existing, created: false };
  }
}
