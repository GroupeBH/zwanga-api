import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ResolvePayoutNotPaidDto } from '../payments/dto/resolve-payout-not-paid.dto';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { PaymentsService } from '../payments/payments.service';
import {
  PAYOUT_RELEASE_GRACE_MS,
  isPayoutRecoveryCheckUnavailable,
} from '../payments/payout-recovery-actions';
import { User } from '../users/entities/user.entity';
import {
  ReferralWithdrawal,
  ReferralWithdrawalStatus,
} from './entities/referral-withdrawal.entity';
import { ReferralWithdrawalResolution } from './entities/referral-withdrawal-resolution.entity';
import { ReferralAccount } from './entities/referral-account.entity';

export async function resolveReferralWithdrawalNotPaid(
  source: DataSource,
  payments: PaymentsService,
  actorId: string,
  id: string,
  dto: ResolvePayoutNotPaidDto,
  applyPayment: (payment: PaymentTransaction) => Promise<ReferralWithdrawal>,
  release: (
    manager: EntityManager,
    withdrawal: ReferralWithdrawal,
    payment: PaymentTransaction | null,
  ) => Promise<void>,
): Promise<ReferralWithdrawal> {
  if (
    dto.confirmedNotPaid !== true ||
    !dto.expectedReference?.trim() ||
    !dto.reason?.trim() ||
    !dto.evidenceReference?.trim()
  ) {
    throw new BadRequestException(
      'La confirmation définitive de non-paiement et sa preuve sont obligatoires',
    );
  }
  const expected = await source
    .getRepository(ReferralWithdrawal)
    .findOneBy({ id });
  if (!expected)
    throw new NotFoundException('Retrait de parrainage introuvable');
  const where = {
    relatedEntityType: 'referral_withdrawal',
    relatedEntityId: id,
    userId: expected.userId,
  };
  const known = await source
    .getRepository(PaymentTransaction)
    .findOne({ where, order: { createdAt: 'DESC' } });
  if (known && known.provider !== PaymentProvider.FLEXPAY) {
    throw new BadRequestException(
      'Résolution manuelle réservée aux retraits FlexPaie',
    );
  }
  // No provider HTTP under database locks. An outage is NOT proof: the operator
  // must still supply definitive out-of-band confirmation of non-execution.
  if (known?.orderNumber) {
    try {
      await applyPayment(
        await payments.checkPaymentStatus(known.orderNumber, expected.userId),
      );
    } catch (error) {
      if (!isPayoutRecoveryCheckUnavailable(error)) throw error;
    }
  }
  return source.transaction(async (manager) => {
    // Same lock order as provider submission and settlement: owner -> withdrawal -> payment -> account.
    await manager.findOne(User, {
      where: { id: expected.userId },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    const withdrawal = await manager.findOne(ReferralWithdrawal, {
      where: { id, userId: expected.userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!withdrawal)
      throw new NotFoundException('Retrait de parrainage introuvable');
    const payment = await manager.findOne(PaymentTransaction, {
      where,
      order: { createdAt: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      (withdrawal.paymentTransactionId &&
        withdrawal.paymentTransactionId !== payment?.id) ||
      (payment &&
        (payment.provider !== PaymentProvider.FLEXPAY ||
          String(payment.purpose) !== String(PaymentPurpose.REFERRAL_PAYOUT) ||
          Number(payment.amount) !== Number(withdrawal.amount) ||
          payment.currency !== withdrawal.currency ||
          payment.phone !== withdrawal.phone))
    ) {
      throw new ConflictException(
        'La transaction liée au retrait est incohérente : rapprochement requis',
      );
    }
    if (dto.expectedReference !== (payment?.reference ?? withdrawal.id)) {
      throw new ConflictException(
        'La référence du retrait a changé : rechargez le dossier',
      );
    }
    if (
      withdrawal.status === ReferralWithdrawalStatus.SUCCEEDED ||
      payment?.status === PaymentStatus.SUCCEEDED
    ) {
      throw new ConflictException(
        'Un versement confirmé ne peut pas être annulé',
      );
    }
    if (
      [
        ReferralWithdrawalStatus.CANCELLED,
        ReferralWithdrawalStatus.FAILED,
      ].includes(withdrawal.status)
    )
      return withdrawal;
    const age =
      Date.now() -
      new Date(withdrawal.requestedAt ?? withdrawal.createdAt).getTime();
    if (!Number.isFinite(age) || age < PAYOUT_RELEASE_GRACE_MS) {
      throw new ConflictException(
        'Le versement est trop récent : attendez la fin du traitement initial',
      );
    }
    if (
      ![
        ReferralWithdrawalStatus.PENDING,
        ReferralWithdrawalStatus.INITIATED,
      ].includes(withdrawal.status)
    ) {
      throw new ConflictException('État du retrait incohérent');
    }
    const account = await manager.findOne(ReferralAccount, {
      where: { userId: withdrawal.userId },
      lock: { mode: 'pessimistic_write' },
    });
    const tokens = Number(withdrawal.tokens);
    if (
      !account ||
      !Number.isFinite(tokens) ||
      tokens <= 0 ||
      !Number.isFinite(Number(account.reservedTokens)) ||
      Number(account.reservedTokens) < tokens
    ) {
      throw new ConflictException(
        'Réservation de jetons incohérente : rapprochement requis',
      );
    }
    await manager.insert(ReferralWithdrawalResolution, {
      withdrawalId: id,
      actorId,
      expectedReference: dto.expectedReference,
      reason: dto.reason.trim(),
      evidenceReference: dto.evidenceReference.trim(),
    });
    withdrawal.paymentTransactionId =
      payment?.id ?? withdrawal.paymentTransactionId;
    await release(manager, withdrawal, payment);
    withdrawal.status = ReferralWithdrawalStatus.CANCELLED;
    withdrawal.processedAt = new Date();
    withdrawal.failureReason =
      'Non-exécution définitive confirmée ; jetons de parrainage rendus disponibles par l’assistance';
    // Leave the provider payment unchanged so a late success is still reconciled.
    // TransactionalNotificationsSubscriber enqueues the user notification on save.
    return manager.save(ReferralWithdrawal, withdrawal);
  });
}
