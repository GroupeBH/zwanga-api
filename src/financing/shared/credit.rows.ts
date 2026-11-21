import type { CreditPolicyRules } from '../policies/credit-policy.rules';
import type { EligibilityFacts } from '../eligibility/credit-eligibility.policy';

export interface IdRow {
  id: string;
}

export interface PolicyRow extends IdRow {
  version: string;
  terms: string;
  rules: CreditPolicyRules;
}

/** Persistence shapes do not depend on HTTP DTO classes. */
export interface ProductDetails {
  vehicleTypes: string[];
  requiredEvidence: string[];
  validityDays?: number;
  processingDays: number;
  brand?: string;
  model?: string;
  specifications?: string;
  warranty?: string;
}

export interface ProductRow extends IdRow {
  code: string;
  kind: 'document' | 'phone' | 'equipment';
  name: string;
  description: string;
  supplierId: string;
  sellerId: string;
  creditorId: string;
  policyId: string;
  currency: 'CDF';
  priceMinor: string;
  feeMinor: string;
  enabled: boolean;
  financingModel: 'ZWANGA_DIRECT' | 'PARTNER_DIRECT' | 'CO_FINANCED';
  details: ProductDetails;
  availableStock?: number;
}

export interface CreditSnapshot {
  product: ProductRow;
  policy: Omit<PolicyRow, 'id'>;
  depositMinor: string;
  principalMinor: string;
  installments: number;
  period: 'week' | 'month';
}

export interface Evaluation {
  eligible: boolean;
  reasons: string[];
  indicativeScore: number;
  risk: string;
  financingLimitMinor: string;
  minimumDepositMinor: string;
  maxInstallments: number;
  rulesVersion?: string;
}

export interface ApplicationData {
  snapshot: CreditSnapshot;
  evaluation: Evaluation;
  evidence: { code: string; attachmentId: string }[];
  vehicleId: string | null;
  caseId: string | null;
}

export interface ApplicationRow extends IdRow {
  driverId: string;
  assetKind: string;
  proProductId: string;
  status: string;
  notes: string;
  createdAt: Date;
  proApplication: ApplicationData;
}

export interface ContractRow extends IdRow {
  driverId: string;
  label: string;
  status: string;
  principalMinor: string;
  paidMinor: string;
  policyVersion: string;
  requestId: string;
  creditorId: string;
  productId: string;
  vehicleId: string | null;
  caseId: string | null;
  snapshot: CreditSnapshot;
  termsHash: string;
  evaluation: Evaluation;
  depositMinor: string;
  depositPaidMinor: string;
  mandateUntil: Date | null;
  mandateRevokedAt: Date | null;
  deliveryState: string;
  deliveryProofId: string | null;
  scheduleVersion: number;
  scheduleBaselineMinor: string;
}

export interface RescheduleRow extends IdRow {
  creditId: string;
  proposedBy: string;
  expectedRemainingMinor: string;
  expectedVersion: number;
  installments: number;
  period: 'week' | 'month';
  reason: string;
  consentedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface EarningRow extends IdRow {
  driverId: string;
  bookingId: string;
  tripId: string;
  status: string;
  currency: string;
  paymentMode: string;
  netAmount: string;
  assetRepaymentAmount: string;
  commissionAmount: string;
  createdAt: Date;
}

export interface AllocationRow {
  creditId: string;
  driverMinor: string;
  platformMinor: string;
  journalIds: string[];
}

export interface ReceiptRow extends IdRow {
  amountMinor: string;
  currency: string;
  createdAt: Date;
  reversesId: string | null;
  purpose: string;
  status: string;
}

export type FactsRow = EligibilityFacts;
