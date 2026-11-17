import type { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';
/** Never relabel repayments as commission or change historical stored net amounts. */
export function spendableEarning(
  earning: Pick<DriverEarning, 'netAmount' | 'assetRepaymentAmount'>,
): number {
  return (
    Math.round(
      (Number(earning.netAmount) - Number(earning.assetRepaymentAmount ?? 0)) *
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
