import { BadRequestException } from '@nestjs/common';
import type {
  PawaPayCallbackKind,
  PawaPayPaymentSnapshot,
} from './pawapay.service';

const idKeys = {
  deposits: 'depositId',
  payouts: 'payoutId',
  refunds: 'refundId',
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const scalar = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function assertPawaPayId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new BadRequestException('Identifiant de paiement PawaPay invalide');
  }
}

/** Parse only the requested operation: a refund is never proof of a deposit. */
export function parsePawaPaySnapshot(
  payload: unknown,
  kind: PawaPayCallbackKind,
): PawaPayPaymentSnapshot {
  const wrapper = record(payload);
  if (!wrapper) throw new BadRequestException('Réponse PawaPay invalide');
  const data = wrapper.status === 'FOUND' ? record(wrapper.data) : wrapper;
  if (!data || !scalar(data.status)) {
    throw new BadRequestException('Statut PawaPay manquant');
  }
  const status = scalar(data.status)!;
  const paymentId = scalar(data[idKeys[kind]]) ?? '';
  if (status !== 'NOT_FOUND') assertPawaPayId(paymentId);
  const failure = record(data.failureReason) ?? {};
  return {
    paymentId,
    status,
    amount: scalar(data.amount),
    currency: scalar(data.currency),
    clientReferenceId: scalar(data.clientReferenceId),
    providerTransactionId: scalar(data.providerTransactionId),
    paymentUrl: scalar(data.authorizationUrl),
    failureCode: scalar(failure.failureCode),
    failureMessage: scalar(failure.failureMessage),
    raw: wrapper,
  };
}
