import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { validateSync } from 'class-validator';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';
import {
  PaymentProvider,
  PaymentStatus,
  PaymentTransaction,
  PaymentPurpose,
} from './entities/payment-transaction.entity';
import { PayoutRetry, PayoutRetryKind } from './entities/payout-retry.entity';
import { RetryPayoutDto } from './dto/retry-payout.dto';
import { payoutRecoveryActions } from './payout-recovery-actions';

export interface PayoutRetryContext {
  actorId: string;
  kind: PayoutRetryKind;
  sourceId: string;
  proof: RetryPayoutDto;
}

export async function authorizePayoutRetry(
  manager: EntityManager,
  actorId: string,
  proof: RetryPayoutDto,
) {
  const actor = await manager.findOneBy(User, { id: actorId });
  if (
    actor?.role !== UserRole.SUPER_ADMIN ||
    actor.passwordChangeRequired ||
    !actor.isActive ||
    [UserStatus.SUSPENDED, UserStatus.INACTIVE].includes(actor.status)
  )
    throw new ForbiddenException(
      'La relance est réservée au super administrateur actif.',
    );
  if (validateSync(Object.assign(new RetryPayoutDto(), proof)).length)
    throw new BadRequestException(
      'Confirmez la non-réception et la non-exécution définitive, avec motif et référence de preuve.',
    );
}

/** Caller holds the owner lock. No network inside this transaction. */
export async function validatePayoutRetrySource(
  manager: EntityManager,
  context: PayoutRetryContext,
  seen = new Set<string>(),
): Promise<DriverPayout | ReferralWithdrawal> {
  const { kind, sourceId, proof } = context;
  if (seen.has(sourceId) || seen.size >= 50)
    throw new ConflictException(
      'Historique de relance à rapprocher manuellement.',
    );
  seen.add(sourceId);
  const source =
    kind === 'driver_payout'
      ? await manager.findOne(DriverPayout, {
          where: { id: sourceId },
          lock: { mode: 'pessimistic_write' },
        })
      : await manager.findOne(ReferralWithdrawal, {
          where: { id: sourceId },
          lock: { mode: 'pessimistic_write' },
        });
  if (
    !source ||
    !['failed', 'cancelled'].includes(source.status) ||
    ('recoveryBlocked' in source && source.recoveryBlocked)
  )
    throw new ConflictException(
      'Le premier retrait doit être résolu comme non payé avant toute relance.',
    );
  const userId = 'driverId' in source ? source.driverId : source.userId;
  const payment = await manager.findOne(PaymentTransaction, {
    where: {
      relatedEntityType: kind,
      relatedEntityId: sourceId,
      userId,
    },
    order: { createdAt: 'DESC' },
    lock: { mode: 'pessimistic_write' },
  });
  if (payment?.status === PaymentStatus.SUCCEEDED)
    throw new BadRequestException({
      code: 'PAYOUT_RETRY_SOURCE_PAID',
      message:
        'Le premier versement est confirmé comme payé. Aucun nouvel envoi autorisé.',
    });
  if (
    source.paymentTransactionId &&
    source.paymentTransactionId !== payment?.id
  )
    throw new ConflictException(
      'La transaction du premier retrait est incohérente.',
    );
  if (
    payment &&
    (payment.provider !== PaymentProvider.FLEXPAY ||
      payment.purpose !==
        (kind === 'driver_payout'
          ? PaymentPurpose.DRIVER_PAYOUT
          : PaymentPurpose.REFERRAL_PAYOUT) ||
      Number(payment.amount) !== Number(source.amount) ||
      payment.currency !== source.currency ||
      payment.phone?.replace(/^\+/, '') !== source.phone.replace(/^\+/, ''))
  )
    throw new ConflictException(
      'Les paramètres du premier versement sont incohérents.',
    );
  if ((payment?.reference ?? source.id) !== proof.expectedReference)
    throw new ConflictException(
      'La référence a changé. Actualisez le dossier avant de relancer.',
    );
  const parent = await manager.findOneBy(PayoutRetry, {
    kind,
    replacementId: sourceId,
  });
  if (parent)
    await validatePayoutRetrySource(
      manager,
      {
        ...parent,
        proof: {
          ...parent,
          confirmedNotPaid: true,
          confirmedNotReceived: true,
        },
      },
      seen,
    );
  return source;
}

export async function recordPayoutRetry(
  manager: EntityManager,
  context: PayoutRetryContext,
  replacementId: string,
) {
  await manager.insert(PayoutRetry, {
    kind: context.kind,
    sourceId: context.sourceId,
    replacementId,
    actorId: context.actorId,
    expectedReference: context.proof.expectedReference,
    reason: context.proof.reason.trim(),
    evidenceReference: context.proof.evidenceReference.trim(),
  });
}

/** Fence late success persisted between reservation and provider submission. */
export async function assertPayoutRetryMaySubmit(
  manager: EntityManager,
  kind: PayoutRetryKind,
  replacementId: string,
) {
  const retry = await manager.findOneBy(PayoutRetry, { kind, replacementId });
  if (!retry) return;
  await validatePayoutRetrySource(manager, {
    ...retry,
    proof: { ...retry, confirmedNotPaid: true, confirmedNotReceived: true },
  });
}

export async function payoutRetryDetails(
  manager: EntityManager,
  kind: PayoutRetryKind,
  source: DriverPayout | ReferralWithdrawal,
  payment: PaymentTransaction | null,
) {
  const [retry, retryOf] = await Promise.all([
    manager.findOneBy(PayoutRetry, { kind, sourceId: source.id }),
    manager.findOneBy(PayoutRetry, { kind, replacementId: source.id }),
  ]);
  return {
    retry,
    retryOf,
    canAdminRetry:
      !retry &&
      (!('recoveryBlocked' in source) || !source.recoveryBlocked) &&
      (!payment || payment.provider === PaymentProvider.FLEXPAY) &&
      payment?.status !== PaymentStatus.SUCCEEDED &&
      (!source.paymentTransactionId ||
        source.paymentTransactionId === payment?.id) &&
      (['failed', 'cancelled'].includes(source.status) ||
        payoutRecoveryActions(source, payment).canResolveNotPaid),
  };
}
