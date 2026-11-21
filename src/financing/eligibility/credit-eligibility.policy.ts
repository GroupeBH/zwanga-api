import type { CreditPolicyRules } from '../policies/credit-policy.rules';
import { minor, minimum } from '../shared/money';

export interface EligibilityFacts {
  activeDriver: boolean;
  kycApproved: boolean;
  accountDays: number;
  settledTrips: number;
  revenueMinor: string;
  activeCredits: number;
  overdue: boolean;
}

export function evaluateCredit(
  facts: EligibilityFacts,
  rules: CreditPolicyRules,
  principal: string,
  deposit: string,
  price: string,
) {
  const reasons: string[] = [];
  if (!facts.activeDriver) reasons.push('ACTIVE_DRIVER_REQUIRED');
  if (!facts.kycApproved) reasons.push('KYC_REQUIRED');
  if (facts.overdue) reasons.push('OVERDUE_FINANCING');
  if (facts.activeCredits >= rules.maxActiveCredits)
    reasons.push('ACTIVE_CREDIT_LIMIT');
  const established =
    facts.accountDays >= rules.minAccountDays &&
    facts.settledTrips >= rules.minSettledTrips &&
    BigInt(facts.revenueMinor) >= minor(rules.minRevenueMinor);
  const limit = minimum(
    minor(rules.maxPrincipalMinor),
    established
      ? minor(rules.maxPrincipalMinor)
      : minor(rules.newcomerLimitMinor),
  );
  if (minor(principal, false) > limit) reasons.push('FINANCING_LIMIT');
  // Ceil to wallet precision: the minimum deposit must never be underquoted.
  const minDeposit =
    ((minor(price, false) * BigInt(rules.minDepositBps) + 99999n) / 100000n) *
    10n;
  if (minor(deposit) < minDeposit) reasons.push('MINIMUM_DEPOSIT');
  return {
    eligible: reasons.length === 0,
    reasons,
    indicativeScore: reasons.length ? 0 : established ? 80 : 50,
    risk: established ? 'standard' : 'new_driver',
    financingLimitMinor: limit.toString(),
    minimumDepositMinor: minDeposit.toString(),
    maxInstallments: rules.maxInstallments,
  };
}
