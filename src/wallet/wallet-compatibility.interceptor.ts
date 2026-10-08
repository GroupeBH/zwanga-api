import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs/operators';

export function legacyWalletResponse(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value };
  for (const key of ['account', 'senderAccount', 'recipientAccount']) {
    const account = value[key];
    if (!account || account.type !== 'points') continue;
    const total = Number(account.balance);
    const purchased = Number(account.withdrawableBalance ?? 0);
    const held = Number(account.reservedCashCommissionBalance ?? 0);
    if (![total, purchased, held].every(Number.isFinite)) continue;
    const available = Math.max(0, Math.round((total - held) * 100) / 100);
    result[key] = {
      ...account,
      // Read-only presentation: ledger entries and persisted balances are untouched.
      totalBalance: account.balance,
      totalWithdrawableBalance: account.withdrawableBalance,
      heldCashCommissionBalance: held,
      balance: available,
      withdrawableBalance: Math.min(purchased, available),
      reservedCashCommissionBalance: 0,
    };
  }
  return result;
}

@Injectable()
export class WalletCompatibilityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const modern =
      http.getRequest().headers?.['x-zwanga-finance-contract'] === '2';
    http.getResponse().vary('X-Zwanga-Finance-Contract');
    return next
      .handle()
      .pipe(map((value) => (modern ? value : legacyWalletResponse(value))));
  }
}
