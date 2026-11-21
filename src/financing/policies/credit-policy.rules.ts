export interface CreditPolicyRules {
  minAccountDays: number;
  minSettledTrips: number;
  minRevenueMinor: string;
  maxActiveCredits: number;
  maxPrincipalMinor: string;
  newcomerLimitMinor: string;
  minDepositBps: number;
  maxInstallments: number;
  fixedPerTripMinor: string;
  netIncomeBps: number;
  commissionShareBps: number;
  allowBeforeDelivery: boolean;
}
