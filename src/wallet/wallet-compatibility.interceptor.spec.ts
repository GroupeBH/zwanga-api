import { firstValueFrom, of } from 'rxjs';
import {
  legacyWalletResponse,
  WalletCompatibilityInterceptor,
} from './wallet-compatibility.interceptor';

describe('wallet contract compatibility', () => {
  const response = () => ({
    account: {
      type: 'points',
      balance: '50.00',
      withdrawableBalance: '50.00',
      reservedCashCommissionBalance: '5.00',
    },
    recentEntries: [{ balanceAfter: 50 }],
  });
  it('shows only spendable/purchased free funds to build 145 without mutating stored data', () => {
    const input = response();
    expect(legacyWalletResponse(input).account).toMatchObject({
      balance: 45,
      withdrawableBalance: 45,
      totalBalance: '50.00',
      reservedCashCommissionBalance: 0,
      heldCashCommissionBalance: 5,
    });
    expect(input.account.balance).toBe('50.00');
    expect(legacyWalletResponse(input).recentEntries).toBe(input.recentEntries);
  });
  it('does not make bonus tokens withdrawable', () => {
    const input = response();
    input.account.withdrawableBalance = '0.00';
    expect(legacyWalletResponse(input).account.withdrawableBalance).toBe(0);
  });
  it('keeps the complete modern contract with explicit cash holds', async () => {
    const input = response(),
      vary = jest.fn();
    const context: any = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-zwanga-finance-contract': '2' } }),
        getResponse: () => ({ vary }),
      }),
    };
    expect(
      await firstValueFrom(
        new WalletCompatibilityInterceptor().intercept(context, {
          handle: () => of(input),
        }),
      ),
    ).toBe(input);
    expect(vary).toHaveBeenCalledWith('X-Zwanga-Finance-Contract');
  });
  it('does not change transfers, payment amounts, ledger balances or withdrawal responses', () => {
    const input = { amount: 50, balanceAfter: 200, status: 'pending' };
    expect(legacyWalletResponse(input)).toEqual(input);
  });
});
