import { validateRepaymentPlans, selectRepaymentPlan } from './repayment-plans';
describe('monthly credit plans', () => {
  const fields = { principalMinor: 120000, cashPriceMinor: 100000, creditFeeMinor: 20000, installmentPeriod: 'month', installmentCount: 3 };
  it('supports legacy single schedules and validates explicit options', () => {
    expect(validateRepaymentPlans(undefined, fields)).toEqual([]);
    expect(selectRepaymentPlan({}, undefined)).toBeNull();
    expect(() => selectRepaymentPlan({}, 'forged')).toThrow();
    expect(validateRepaymentPlans([{ id: 'm3', months: 3 }, { id: 'm6', months: 6 }], fields)).toHaveLength(2);
  });
  it('rejects duplicate IDs, invalid durations, missing cost and mismatched defaults', () => {
    for (const plans of [[{ id: 'same', months: 3 }, { id: 'same', months: 6 }], [{ id: 'x', months: 0 }],
      [{ id: 'x', months: 121 }], [{ id: '<script>', months: 3 }], [{ id: 'x', months: 2.5 }], [{ id: 'x', months: 6 }]])
      expect(() => validateRepaymentPlans(plans, fields)).toThrow();
    expect(() => validateRepaymentPlans([{ id: 'm3', months: 3 }], { ...fields, creditFeeMinor: undefined })).toThrow();
  });
  it('requires an explicit existing plan and preserves a previous agreement', () => {
    const credit = { repaymentPlans: [{ id: 'm3', months: 3 }, { id: 'm6', months: 6 }] };
    expect(() => selectRepaymentPlan(credit)).toThrow();
    expect(selectRepaymentPlan(credit, 'm6')).toEqual({ id: 'm6', months: 6 });
    expect(() => selectRepaymentPlan({ ...credit, selectedPlanId: 'm3' }, 'm6')).toThrow();
  });
});
