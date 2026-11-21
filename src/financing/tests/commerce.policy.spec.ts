import {
  commercePrices,
  purchaseQuote,
  earlySettlement,
  CommerceTerms,
} from '../commerce/commerce.policy';
const terms: CommerceTerms = {
  version: 'commerce-v1',
  acquisitionMinor: '60000',
  expensesMinor: '10000',
  marginMinor: '30000',
  minimumMarginMinor: '10000',
  depositMinor: '10000',
  plans: [
    { id: 'three-months', period: 'month', count: 3 },
    { id: 'six-weeks', period: 'week', count: 6 },
  ],
};
describe('Commercial terms', () => {
  it('computes cash 80 percent and preserves exact installment sum', () => {
    const quote = purchaseQuote(
      { id: 'test', commerce: terms, revision: 1 },
      'credit',
      'three-months',
    );
    expect(quote.cashTotalMinor).toBe('80000');
    expect(quote.cashSavingMinor).toBe('20000');
    expect(quote.installmentAmountsMinor).toEqual(['30000', '30000', '30000']);
    expect(JSON.stringify(quote)).not.toMatch(
      /acquisitionMinor|expensesMinor|minimumMarginMinor/,
    );
    const cash = purchaseQuote(
      { id: 'test', commerce: terms, revision: 1 },
      'cash',
    );
    expect(cash).toMatchObject({
      depositMinor: '0',
      totalMinor: '80000',
      beforeDeliveryMinor: '80000',
    });
  });
  it('requires a profitable cash price and refuses duplicate or unknown plans', () => {
    expect(() => commercePrices({ ...terms, marginMinor: '0' })).toThrow();
    expect(() =>
      commercePrices({ ...terms, plans: [terms.plans[0], terms.plans[0]] }),
    ).toThrow();
    expect(() =>
      purchaseQuote(
        { id: 'test', commerce: terms, revision: 1 },
        'credit',
        'forged',
      ),
    ).toThrow();
  });
  it('changes quote hash when product revision or mode changes', () => {
    const first = purchaseQuote(
      { id: 'test', commerce: terms, revision: 1 },
      'cash',
    );
    expect(
      purchaseQuote({ id: 'test', commerce: terms, revision: 2 }, 'cash')
        .quoteHash,
    ).not.toBe(first.quoteHash);
  });
  const input = {
    remainingMinor: '100000',
    period: 'month' as const,
    finalDueAt: '2027-05-31T12:00:00Z',
    hasOverdue: false,
    mode: 'credit' as const,
    version: 'commerce-v1',
  };
  it('discounts only the remaining balance, not the initial price', () => {
    expect(earlySettlement(input, new Date('2027-03-01Z'))).toMatchObject({
      amountMinor: '90000',
      discountMinor: '10000',
      validUntil: '2027-04-30T12:00:00.000Z',
    });
  });
  it.each([
    { hasOverdue: true },
    { mode: 'cash' as const },
    { version: 'legacy' },
  ])('refuses ineligible settlement %j', (overrides) => {
    expect(() =>
      earlySettlement({ ...input, ...overrides }, new Date('2027-03-01Z')),
    ).toThrow();
  });
  it('refuses a last-period payoff', () =>
    expect(() => earlySettlement(input, new Date('2027-05-01Z'))).toThrow());
});
