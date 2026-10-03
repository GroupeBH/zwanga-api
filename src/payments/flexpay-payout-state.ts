import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import {
  DriverPayout,
  DriverPayoutStatus,
} from '../driver-settlements/entities/driver-payout.entity';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

/** A delayed acknowledgement/check must not overwrite a confirmed success. */
export async function commitFlexPayPayoutState(
  repository: Repository<PaymentTransaction>,
  expected: PaymentTransaction,
): Promise<PaymentTransaction> {
  return repository.manager.transaction(async (manager) => {
    const current = await manager.findOne(PaymentTransaction, {
      where: { id: expected.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!current) throw new NotFoundException('Transaction introuvable');
    if (
      current.provider !== PaymentProvider.FLEXPAY ||
      current.reference !== expected.reference ||
      (current.orderNumber &&
        expected.orderNumber &&
        current.orderNumber !== expected.orderNumber)
    ) {
      throw new BadRequestException('La tentative de versement a changé');
    }
    if (
      current.status === PaymentStatus.SUCCEEDED ||
      ([PaymentStatus.FAILED, PaymentStatus.CANCELLED].includes(
        current.status,
      ) &&
        expected.status !== PaymentStatus.SUCCEEDED)
    ) {
      return current;
    }
    // Only provider-owned fields; never overwrite ownership/amount/reference from a stale object.
    Object.assign(current, {
      status: expected.status,
      orderNumber: expected.orderNumber ?? current.orderNumber,
      providerReference:
        expected.providerReference ?? current.providerReference,
      providerStatusCode: expected.providerStatusCode,
      providerMessage: expected.providerMessage,
      rawInitiationResponse:
        expected.rawInitiationResponse ?? current.rawInitiationResponse,
      rawCallbackPayload:
        expected.rawCallbackPayload ?? current.rawCallbackPayload,
      rawCheckResponse: expected.rawCheckResponse ?? current.rawCheckResponse,
      paidAt: current.paidAt ?? expected.paidAt,
    });
    return manager.save(PaymentTransaction, current);
  });
}

/** Serialize creation with support cancellation and concurrent idempotent retries. */
export async function claimDriverPayoutPayment(
  repository: Repository<PaymentTransaction>,
  draft: PaymentTransaction,
) {
  return repository.manager.transaction(async (manager) => {
    await manager.findOne(User, {
      where: { id: draft.userId! },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    const payout = await manager.findOne(DriverPayout, {
      where: { id: draft.relatedEntityId!, driverId: draft.userId! },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payout) throw new NotFoundException('Retrait introuvable');
    const existing = await manager.findOne(PaymentTransaction, {
      where: {
        relatedEntityType: 'driver_payout',
        relatedEntityId: payout.id,
        userId: payout.driverId,
      },
      order: { createdAt: 'DESC' },
    });
    if (existing) return { payment: existing, created: false };
    if (
      payout.status !== DriverPayoutStatus.PENDING ||
      payout.fundsReleasedAt ||
      payout.recoveryBlocked ||
      Number(payout.amount) !== Number(draft.amount) ||
      payout.currency !== draft.currency ||
      draft.purpose !== String(PaymentPurpose.DRIVER_PAYOUT)
    ) {
      throw new ConflictException('Ce retrait ne peut plus être envoyé');
    }
    const payment = await manager.save(PaymentTransaction, draft);
    payout.paymentTransactionId = payment.id;
    await manager.save(DriverPayout, payout);
    return { payment, created: true };
  });
}
