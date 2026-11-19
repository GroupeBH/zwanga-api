import type { CreditPolicyRules } from '../policies/credit-policy.rules';
import { minor, cents, decimal } from '../shared/money';
import { repaymentAllocation } from '../repayments/repayment-allocation.policy';
import { evaluateCredit } from '../eligibility/credit-eligibility.policy';
import { schedule } from '../schedules/installment-schedule.policy';

export const rules: CreditPolicyRules = {
  minAccountDays: 30,
  minSettledTrips: 10,
  minRevenueMinor: '100000',
  maxActiveCredits: 2,
  maxPrincipalMinor: '1000000',
  newcomerLimitMinor: '100000',
  minDepositBps: 1000,
  maxInstallments: 12,
  fixedPerTripMinor: '0',
  netIncomeBps: 500,
  commissionShareBps: 0,
  allowBeforeDelivery: false,
};
describe('Zwanga Pro exact contractual rules', () => {
  it.each(['1.2', '1e3', '-10', '10x', '01', '1000000000010', '11'])(
    'rejects inexact money %s',
    (value) => expect(() => minor(value)).toThrow(),
  );
  it('does not accept JS numeric money', () =>
    expect(() => minor(100 as unknown as string)).toThrow());
  it('converts decimal database amounts without floating point', () => {
    expect(cents('20000.05')).toBe(2000005n);
    expect(decimal(2000005n)).toBe('20000.05');
  });
  it('deducts 850 CDF from a 17000 CDF net, independently of the commission', () => {
    expect(
      repaymentAllocation(rules, 1700000n, 300000n, 200000n, 1700000n),
    ).toEqual({ driver: 85000n, platform: 0n, total: 85000n });
  });
  it('caps the aggregate at outstanding and available settled income', () => {
    expect(
      repaymentAllocation(
        { ...rules, fixedPerTripMinor: '1000', commissionShareBps: 5000 },
        100000n,
        10000n,
        2000n,
        1000n,
      ),
    ).toEqual({ driver: 1000n, platform: 1000n, total: 2000n });
  });
  it('stops at zero outstanding', () =>
    expect(repaymentAllocation(rules, 100000n, 10000n, 0n, 100000n).total).toBe(
      0n,
    ));
  it('allows an explicitly configured small first financing', () => {
    expect(
      evaluateCredit(
        {
          activeDriver: true,
          kycApproved: true,
          accountDays: 0,
          settledTrips: 0,
          revenueMinor: '0',
          activeCredits: 0,
          overdue: false,
        },
        rules,
        '90000',
        '10000',
        '100000',
      ),
    ).toMatchObject({
      eligible: true,
      risk: 'new_driver',
      financingLimitMinor: '100000',
    });
  });
  it('explains KYC, activity, debt, amount and deposit failures', () => {
    const result = evaluateCredit(
      {
        activeDriver: false,
        kycApproved: false,
        accountDays: 0,
        settledTrips: 0,
        revenueMinor: '0',
        activeCredits: 2,
        overdue: true,
      },
      rules,
      '200000',
      '0',
      '200000',
    );
    expect(result.reasons).toEqual([
      'ACTIVE_DRIVER_REQUIRED',
      'KYC_REQUIRED',
      'OVERDUE_FINANCING',
      'ACTIVE_CREDIT_LIMIT',
      'FINANCING_LIMIT',
      'MINIMUM_DEPOSIT',
    ]);
  });
  it('preserves all cents and clamps monthly dates at end of month', () => {
    const items = schedule(1000n, 3, 'month', new Date('2026-01-31T12:00:00Z'));
    expect(items.map((i) => i.amountMinor)).toEqual(['330', '330', '340']);
    expect(items.map((i) => i.dueAt)).toEqual([
      '2026-02-28T12:00:00.000Z',
      '2026-03-31T12:00:00.000Z',
      '2026-04-30T12:00:00.000Z',
    ]);
  });
  it('weekly schedule and minimum quantum', () => {
    expect(schedule(20n, 2, 'week', new Date('2026-01-01Z'))[1].dueAt).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    expect(() => schedule(10n, 2, 'week', new Date())).toThrow();
  });
});
