import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  PaymentProvider,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import type { PawaPayPaymentSnapshot } from './pawapay.service';

export function assertPawaPaySnapshotMatches(
  payment: PaymentTransaction,
  snapshot: PawaPayPaymentSnapshot,
): void {
  if (
    payment.provider !== PaymentProvider.PAWAPAY ||
    !payment.orderNumber ||
    snapshot.paymentId !== payment.orderNumber ||
    (snapshot.clientReferenceId &&
      snapshot.clientReferenceId !== payment.reference)
  ) {
    throw new BadRequestException(
      'La réponse PawaPay ne correspond pas à cette transaction',
    );
  }
  if (snapshot.status === 'COMPLETED') {
    const amount = snapshot.amount ?? '';
    if (
      !/^\d+(\.\d+)?$/.test(amount) ||
      !Number.isFinite(Number(amount)) ||
      Number(amount) <= 0 ||
      Number(amount) !== Number(payment.amount) ||
      !snapshot.currency ||
      snapshot.currency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      throw new BadRequestException(
        'Le montant ou la devise PawaPay ne correspond pas à cette transaction',
      );
    }
  }
}

/** No HTTP under the lock; late callbacks/checks/POST responses cannot regress a final state. */
export async function commitPawaPayState(
  repository: Repository<PaymentTransaction>,
  expected: PaymentTransaction,
  patch: Partial<PaymentTransaction>,
): Promise<PaymentTransaction> {
  return repository.manager.transaction(async (manager) => {
    const current = await manager.findOne(PaymentTransaction, {
      where: { id: expected.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!current) throw new NotFoundException('Transaction introuvable');
    if (
      current.provider !== PaymentProvider.PAWAPAY ||
      current.orderNumber !== expected.orderNumber
    ) {
      throw new BadRequestException(
        'Le prestataire ou la tentative de paiement a changé',
      );
    }
    const terminal = [
      PaymentStatus.SUCCEEDED,
      PaymentStatus.FAILED,
      PaymentStatus.CANCELLED,
    ];
    if ([PaymentStatus.FAILED, PaymentStatus.CANCELLED].includes(current.status) &&
        patch.status === PaymentStatus.SUCCEEDED) {
      // Funds may already have been released for another payout. Do not silently
      // acknowledge a contradictory final state; operations must reconcile it.
      throw new BadGatewayException('Confirmation PawaPay contradictoire : rapprochement manuel requis');
    }
    if (terminal.includes(current.status) && current.status !== patch.status)
      return current;
    if (current.paidAt) patch.paidAt = current.paidAt;
    return manager.save(PaymentTransaction, Object.assign(current, patch));
  });
}
