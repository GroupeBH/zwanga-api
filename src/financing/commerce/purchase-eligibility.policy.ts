import {
  EligibilityFacts,
  evaluateCredit,
} from '../eligibility/credit-eligibility.policy';
import { CreditPolicyRules } from '../policies/credit-policy.rules';
/** Cash purchases carry no loan exposure, but never bypass active-account / driver / KYC checks. */
export function evaluatePurchase(
  facts: EligibilityFacts,
  rules: CreditPolicyRules,
  principal: string,
  deposit: string,
  price: string,
  mode?: string,
) {
  if (mode !== 'cash')
    return evaluateCredit(facts, rules, principal, deposit, price);
  const reasons = [
    ...(!facts.activeDriver ? ['ACTIVE_DRIVER_REQUIRED'] : []),
    ...(!facts.kycApproved ? ['KYC_REQUIRED'] : []),
  ];
  return {
    eligible: reasons.length === 0,
    reasons,
    indicativeScore: 0,
    risk: 'cash_purchase',
    financingLimitMinor: '0',
    minimumDepositMinor: '0',
    maxInstallments: 1,
  };
}
