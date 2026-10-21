import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import {
  ReferralWithdrawal,
  ReferralWithdrawalStatus,
} from '../referrals/entities/referral-withdrawal.entity';
import {
  PaymentPurpose,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

/** Serializes provider submission against unsent-reservation recovery. No HTTP here. */
export async function claimReferralPayoutPayment(
  repository: Repository<PaymentTransaction>,
  draft: PaymentTransaction,
) {
  if (
    !draft.userId ||
    !draft.relatedEntityId ||
    draft.relatedEntityType !== 'referral_withdrawal' ||
    draft.purpose !== PaymentPurpose.REFERRAL_PAYOUT
  )
    throw new BadRequestException('Retrait de parrainage non lié');
  return repository.manager.transaction(async (manager) => {
    await manager.findOne(User, {
      where: { id: draft.userId! },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    const withdrawal = await manager.findOne(ReferralWithdrawal, {
      where: { id: draft.relatedEntityId!, userId: draft.userId! },
      lock: { mode: 'pessimistic_write' },
    });
    if (!withdrawal) throw new NotFoundException('Retrait introuvable');
    if (
      draft.purpose !== PaymentPurpose.REFERRAL_PAYOUT ||
      Number(draft.amount) !== Number(withdrawal.amount) ||
      draft.currency !== withdrawal.currency ||
      draft.phone !== withdrawal.phone
    ) {
      throw new BadRequestException('Transaction de retrait incohérente');
    }
    const existing = await manager.findOne(PaymentTransaction, {
      where: {
        relatedEntityType: 'referral_withdrawal',
        relatedEntityId: withdrawal.id,
        userId: withdrawal.userId,
      },
      order: { createdAt: 'DESC' },
    });
    if (existing) {
      if (
        existing.purpose !== draft.purpose ||
        Number(existing.amount) !== Number(draft.amount) ||
        existing.currency !== draft.currency ||
        existing.phone !== draft.phone
      )
        throw new ConflictException(
          'Une transaction incompatible est déjà liée au retrait',
        );
      return { payment: existing, created: false };
    }
    if (
      withdrawal.status !== ReferralWithdrawalStatus.PENDING ||
      withdrawal.paymentTransactionId
    )
      throw new ConflictException('Ce retrait ne peut plus être envoyé');
    const payment = await manager.save(PaymentTransaction, draft);
    withdrawal.paymentTransactionId = payment.id;
    await manager.save(ReferralWithdrawal, withdrawal);
    return { payment, created: true };
  });
}
