import { applyTokenMovement, refundablePurchasedTokens } from './wallet-origin';

describe('wallet token provenance', () => {
  it('spends rewards first for a mixed wallet', () => {
    const account = { balance: 100, withdrawableBalance: 70 };
    expect(applyTokenMovement(account, -20)).toBe(0);
    expect(account).toEqual({ balance: 80, withdrawableBalance: 70 });
    expect(applyTokenMovement(account, -30)).toBe(-20);
    expect(account).toEqual({ balance: 50, withdrawableBalance: 50 });
  });
  it('cannot withdraw loyalty despite a large total balance', () => {
    const account = { balance: 1000, withdrawableBalance: 2 };
    expect(() => applyTokenMovement(account, -3, 0, true)).toThrow(
      'retirables insuffisant',
    );
    expect(account.balance).toBe(1000);
    expect(applyTokenMovement(account, -2, 0, true)).toBe(-2);
    expect(account).toEqual({ balance: 998, withdrawableBalance: 0 });
  });
  it('preserves purchased and reward provenance through multiple transfers', () => {
    const sender = { balance: 100, withdrawableBalance: 60 };
    const receiver = { balance: 0, withdrawableBalance: 0 };
    const third = { balance: 0, withdrawableBalance: 0 };
    const purchased = -applyTokenMovement(sender, -80);
    applyTokenMovement(receiver, 80, purchased);
    expect(receiver).toEqual({ balance: 80, withdrawableBalance: 40 });
    applyTokenMovement(third, 30, -applyTokenMovement(receiver, -30));
    expect(third).toEqual({ balance: 30, withdrawableBalance: 0 });
    expect(() => applyTokenMovement(third, -1, 0, true)).toThrow();
    expect(receiver).toEqual({ balance: 50, withdrawableBalance: 40 });
  });
  it('never promotes loyalty, subscription rewards or admin credits to purchased tokens', () => {
    const account = { balance: 0, withdrawableBalance: 0 };
    applyTokenMovement(account, 1);
    applyTokenMovement(account, 25);
    applyTokenMovement(account, 50);
    expect(account).toEqual({ balance: 76, withdrawableBalance: 0 });
    applyTokenMovement(account, 10, 10);
    expect(account).toEqual({ balance: 86, withdrawableBalance: 10 });
  });
  it('caps purchased refunds at the original debit across partial and full refunds', () => {
    const debit = { amount: -100, withdrawableAmount: -60 };
    expect(refundablePurchasedTokens(debit, [], 50)).toBe(50);
    expect(
      refundablePurchasedTokens(
        debit,
        [{ amount: 50, withdrawableAmount: 50 }],
        50,
      ),
    ).toBe(10);
    expect(() =>
      refundablePurchasedTokens(
        debit,
        [{ amount: 50, withdrawableAmount: 50 }],
        51,
      ),
    ).toThrow();
    expect(
      refundablePurchasedTokens(
        { amount: -100, withdrawableAmount: null },
        [],
        100,
      ),
    ).toBe(0);
    expect(
      refundablePurchasedTokens(
        { amount: -100, withdrawableAmount: 0 },
        [],
        100,
      ),
    ).toBe(0);
  });
  it('uses integer token cents and fails closed for invalid values or accounts under review', () => {
    const account = { balance: 0.3, withdrawableBalance: 0.2 };
    expect(applyTokenMovement(account, -0.2)).toBe(-0.1);
    expect(account).toEqual({ balance: 0.1, withdrawableBalance: 0.1 });
    expect(() => applyTokenMovement(account, NaN)).toThrow();
    expect(() =>
      applyTokenMovement({ ...account, withdrawalsBlocked: true }, -0.01),
    ).toThrow('vérification');
  });
});
