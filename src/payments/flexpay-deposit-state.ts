import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  PaymentProvider,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { hasVerifiedWalletTopUpProof } from './wallet-topup-proof';

/** HTTP has already finished. Merge only provider fields under the payment lock. */
export async function commitFlexPayDepositState(
  repository: Repository<PaymentTransaction>,
  candidate: PaymentTransaction,
  initiation = false,
): Promise<PaymentTransaction> {
  return repository.manager.transaction(async (manager) => {
    const current = await manager.findOne(PaymentTransaction, {
      where: { id: candidate.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!current) throw new NotFoundException('Paiement introuvable');
    if (
      current.provider !== PaymentProvider.FLEXPAY ||
      current.reference !== candidate.reference ||
      (current.orderNumber &&
        candidate.orderNumber &&
        current.orderNumber !== candidate.orderNumber)
    ) {
      throw new BadRequestException('La tentative de paiement a changé');
    }
    if (
      current.status === PaymentStatus.SUCCEEDED &&
      (initiation ||
        candidate.status !== PaymentStatus.SUCCEEDED ||
        hasVerifiedWalletTopUpProof(current))
    )
      return current;
    if (
      [PaymentStatus.FAILED, PaymentStatus.CANCELLED].includes(current.status) &&
      (initiation || candidate.status !== PaymentStatus.SUCCEEDED)
    )
      return current;
    Object.assign(current, {
      status: candidate.status,
      providerStatusCode: candidate.providerStatusCode,
      providerMessage: candidate.providerMessage,
      providerReference:
        candidate.providerReference ?? current.providerReference,
      orderNumber: candidate.orderNumber ?? current.orderNumber,
      rawCheckResponse: candidate.rawCheckResponse ?? current.rawCheckResponse,
      rawCallbackPayload:
        candidate.rawCallbackPayload ?? current.rawCallbackPayload,
      paidAt: current.paidAt ?? candidate.paidAt,
      ...(initiation
        ? {
            rawInitiationResponse:
              candidate.rawInitiationResponse ?? current.rawInitiationResponse,
            paymentUrl: candidate.paymentUrl ?? current.paymentUrl,
          }
        : {}),
    });
    return manager.save(PaymentTransaction, current);
  });
}
