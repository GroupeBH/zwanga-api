import type { CreditPolicyRules } from '../policies/credit-policy.rules';
import { minimum, floorWallet, minor } from '../shared/money';

export function repaymentAllocation(
  rules: CreditPolicyRules,
  net: bigint,
  commission: bigint,
  outstanding: bigint,
  available: bigint,
) {
  const driver = minimum(
    floorWallet(
      minor(rules.fixedPerTripMinor) +
        (net * BigInt(rules.netIncomeBps)) / 10000n,
    ),
    floorWallet(available),
    outstanding,
  );
  const platform = minimum(
    floorWallet((commission * BigInt(rules.commissionShareBps)) / 10000n),
    outstanding - driver,
  );
  return { driver, platform, total: driver + platform };
}
