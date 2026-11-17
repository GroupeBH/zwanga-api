import { creditSchedule, validateCreditCost, CREDIT_COST_VERSION } from './credit-cost';

describe('credit cost disclosure', () => {
  it('preserves legacy offers but requires the complete, precise cost breakdown', () => {
    expect(validateCreditCost(10000, {})).toBeNull();
    expect(validateCreditCost(11000, { cashPriceMinor: 10000, creditFeeMinor: 1000 })).toBe(CREDIT_COST_VERSION);
    for (const fields of [{ cashPriceMinor: 10000 }, { cashPriceMinor: 10000, creditFeeMinor: null },
      { cashPriceMinor: 10000, creditFeeMinor: 900 }, { cashPriceMinor: 10001, creditFeeMinor: 999 },
      { cashPriceMinor: 11000, creditFeeMinor: -1 }, { cashPriceMinor: 10000, creditFeeMinor: 1000, installmentCount: 2 },
      { cashPriceMinor: 10000, creditFeeMinor: 1000, installmentCount: 121, installmentPeriod: 'week' as const }])
      expect(() => validateCreditCost(11000, fields)).toThrow();
  });
  const credit = { costDisclosureVersion: CREDIT_COST_VERSION, principalMinor: 10000, paidMinor: 0,
    installmentCount: 3, installmentPeriod: 'month' as const, activatedAt: '2028-01-31T12:00:00Z' };
  it('keeps the month anchor through leap February, rounds exactly and caps the last payment', () => {
    const result = creditSchedule(credit, new Date('2028-02-29T12:00:00Z'));
    expect(result.installments.map(x => x.dueAt)).toEqual(['2028-02-29T12:00:00.000Z','2028-03-31T12:00:00.000Z','2028-04-30T12:00:00.000Z']);
    expect(result.installments.map(x => x.amountMinor)).toEqual([3330,3330,3340]);
    expect(result.minimumDueMinor).toBe(3330);
  });
  it('credits all actual repayments toward minimums without double counting cash shortfalls', () => {
    const result = creditSchedule({ ...credit, paidMinor: 5000 }, new Date('2028-04-01'));
    expect(result.installments.map(x => x.remainingMinor)).toEqual([0,1660,3340]);
    expect(result.minimumDueMinor).toBe(1660);
    expect(creditSchedule({ ...credit, paidMinor: 10000 }, new Date('2029-01-01')).minimumDueMinor).toBe(0);
    expect(creditSchedule({ ...credit, paidMinor: 2000 }, new Date('2029-01-01')).minimumDueMinor).toBe(8000);
  });
  it('starts dates only at handover and uses seven-day weeks', () => {
    const preview = creditSchedule({ ...credit, activatedAt: null });
    expect(preview.minimumDueMinor).toBe(0);
    expect(preview.installments.every(x => x.dueAt === null)).toBe(true);
    expect(creditSchedule({ ...credit, installmentPeriod: 'week' }).installments[0].dueAt).toBe('2028-02-07T12:00:00.000Z');
  });
});
