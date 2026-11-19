import type { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';
/** Never relabel repayments as commission or change historical stored net amounts. */
export function spendableEarning(earning: {
  netAmount: number | string;
  assetRepaymentAmount?: number | string;
  proRepaymentAmount?: number | string;
  proCreditPending?: boolean;
}): number {
  if (earning.proCreditPending) return 0;
  return (
    Math.round(
      (Number(earning.netAmount) -
        Number(earning.assetRepaymentAmount ?? 0) -
        Number(earning.proRepaymentAmount ?? 0)) *
        100,
    ) / 100
  );
}
export function earningForClient(
  earning: DriverEarning,
): DriverEarning & { netBeforeCredit: number } {
  return {
    ...earning,
    netBeforeCredit: Number(earning.netAmount),
    netAmount: spendableEarning(earning),
  };
}
