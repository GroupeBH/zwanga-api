export type PawaPayOperationStatus =
  | 'ACCEPTED'
  | 'DUPLICATE_IGNORED'
  | 'REJECTED'
  | 'SUBMITTED'
  | 'PROCESSING'
  | 'IN_RECONCILIATION'
  | 'ENQUEUED'
  | 'COMPLETED'
  | 'FAILED'
  | 'FOUND'
  | 'NOT_FOUND';

export interface PawaPayInitiateInput {
  paymentId: string;
  phone: string;
  amount: number;
  currency: string;
  description: string;
  clientReferenceId: string;
  operator?: string;
}

export interface PawaPayInitiateResult {
  paymentId: string;
  status: string;
  accepted: boolean;
  paymentUrl: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  raw: Record<string, unknown>;
}

export interface PawaPayPaymentSnapshot {
  paymentId: string;
  status: string;
  amount: string | null;
  currency: string | null;
  clientReferenceId: string | null;
  providerTransactionId: string | null;
  paymentUrl: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  raw: Record<string, unknown>;
}

export type PawaPayCallbackKind = 'deposits' | 'payouts' | 'refunds';
export interface NormalizedPawaPayCallback extends PawaPayPaymentSnapshot {
  kind: PawaPayCallbackKind;
}
