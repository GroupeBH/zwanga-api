import { TOKEN_WITHDRAWAL_DISABLED } from '../payments/token-withdrawal.policy';
import { WalletWithdrawalsService } from './wallet-withdrawals.service';
import { WalletWithdrawal } from './entities/wallet-withdrawal.entity';
import { WalletAccount } from './entities/wallet-account.entity';
import { WalletLedgerEntry } from './entities/wallet-ledger-entry.entity';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { AsyncLocalStorage } from 'async_hooks';

// Transactional in-memory adapter with rollback and serialized lock sections.
// Provider calls remain outside those sections, allowing simultaneous HTTP retries.
function fixture() {
  const state: any = {
    account: {
      id: 'account',
      userId: 'user',
      type: 'points',
      currency: 'PTS',
      balance: 100,
      withdrawableBalance: 60,
      reservedWithdrawalBalance: 0,
      withdrawalsBlocked: false,
    },
    withdrawals: [],
    payments: [],
    ledger: [],
    kyc: true,
    active: true,
  };
  let sequence = 0;
  const transactionContext = new AsyncLocalStorage<boolean>();
  let tail = Promise.resolve();
  const matches = (record: any, where: any) =>
    Object.entries(where).every(([key, value]) => record[key] === value);
  const manager: any = {
    findOne: jest.fn(async (entity: any, { where }: any) => {
      if (entity === User)
        return {
          id: 'user',
          isActive: state.active,
          status: UserStatus.ACTIVE,
        };
      const source =
        entity === WalletAccount
          ? [state.account]
          : entity === WalletWithdrawal
            ? state.withdrawals
            : state.payments;
      const found = source.find((record: any) => matches(record, where));
      return found ? Object.assign(new entity(), structuredClone(found)) : null;
    }),
    exists: jest.fn(async (entity: any, options: any) =>
      entity === KycDocument
        ? state.kyc
        : Boolean(await manager.findOne(entity, options)),
    ),
    create: (entity: any, fields: any) =>
      Object.assign(
        new entity(),
        {
          id: `id-${++sequence}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        fields,
      ),
    save: jest.fn(async (record: any) => {
      if (record instanceof WalletAccount)
        state.account = structuredClone(record);
      else {
        const source =
          record instanceof WalletWithdrawal
            ? state.withdrawals
            : record instanceof WalletLedgerEntry
              ? state.ledger
              : state.payments;
        const index = source.findIndex((item: any) => item.id === record.id);
        if (index >= 0) source[index] = structuredClone(record);
        else source.push(structuredClone(record));
      }
      return record;
    }),
  };
  manager.findOneOrFail = async (entity: any, options: any) => {
    const result = await manager.findOne(entity, options);
    if (!result) throw new Error('Missing row');
    return result;
  };
  const dataSource: any = {
    getRepository: (entity: any) => ({
      findOne: (options: any) => manager.findOne(entity, options),
      find: async ({ where }: any) =>
        state.withdrawals.filter((row: any) => matches(row, where)),
    }),
    transaction: (callback: any) => {
      const result = tail.then(async () => {
        const previous = structuredClone({
          account: state.account,
          withdrawals: state.withdrawals,
          ledger: state.ledger,
        });
        try {
          return await transactionContext.run(true, () => callback(manager));
        } catch (error) {
          Object.assign(state, previous);
          throw error;
        }
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const payments: any = {
    findLatestTransactionForRelatedEntity: jest.fn(
      async (_type, id) =>
        state.payments.find((p: any) => p.relatedEntityId === id) ?? null,
    ),
    initiatePayout: jest.fn(async (input) => {
      expect(transactionContext.getStore()).not.toBe(true);
      const payment = {
        ...input,
        id: 'payment',
        status: PaymentStatus.INITIATED,
        orderNumber: 'order',
      };
      state.payments.push(payment);
      return payment;
    }),
    checkPaymentStatus: jest.fn(async () => state.payments[0]),
    handleFlexPayCallback: jest.fn(async () => state.payments[0]),
  };
  const config: any = {
    get: jest.fn((key) =>
      key === 'WALLET_WITHDRAWALS_ENABLED'
        ? 'true'
        : key === 'PUBLIC_API_BASE_URL'
          ? 'https://api.example.test/api/v1'
          : undefined,
    ),
  };
  const wallet: any = {
    getSummary: jest.fn(async () => ({
      withdrawal: { currency: 'CDF', moneyPerToken: 100 },
    })),
    convertPointsToMoney: (tokens: number) => tokens * 100,
  };
  const service = new WalletWithdrawalsService(
    dataSource,
    payments,
    wallet,
    config,
  );
  const request = {
    tokens: 40,
    phone: '+243891234567',
    idempotencyKey: '2bc492fa-a2b6-4bf0-aae6-582f82602bf6',
  };
  return { service, state, payments, request, config, manager };
}

// Existing provider transfers must still settle after new withdrawals are disabled.
function seedHistoricalWithdrawal(f: ReturnType<typeof fixture>) {
  const withdrawal = {
    id: 'historical-withdrawal',
    userId: 'user',
    ...f.request,
    phone: '243891234567',
    amount: 4000,
    currency: 'CDF',
    moneyPerToken: 100,
    status: PaymentStatus.INITIATED,
    paymentTransactionId: 'payment',
    processedAt: null,
    releasedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  Object.assign(f.state.account, {
    balance: 60,
    withdrawableBalance: 20,
    reservedWithdrawalBalance: 40,
  });
  f.state.withdrawals.push(withdrawal);
  f.state.payments.push({
    id: 'payment',
    userId: 'user',
    purpose: PaymentPurpose.WALLET_PAYOUT,
    relatedEntityType: 'wallet_withdrawal',
    relatedEntityId: withdrawal.id,
    amount: withdrawal.amount,
    currency: withdrawal.currency,
    phone: withdrawal.phone,
    status: PaymentStatus.INITIATED,
    orderNumber: 'order',
  });
  f.state.ledger.push({
    id: 'historical-debit',
    amount: -40,
    withdrawableAmount: -40,
    type: 'withdrawal',
  });
  return withdrawal;
}

describe('disabled token withdrawals and historical settlement', () => {
  it.each([undefined, 'false', 'true'])(
    'blocks new requests even with WALLET_WITHDRAWALS_ENABLED=%s',
    async (flag) => {
      const f = fixture();
      f.config.get.mockReturnValue(flag);
      const before = structuredClone(f.state);
      await expect(f.service.request('user', f.request)).rejects.toMatchObject({
        status: 403,
        response: TOKEN_WITHDRAWAL_DISABLED,
      });
      expect(f.state).toEqual(before);
      expect(f.manager.findOne).not.toHaveBeenCalled();
      expect(f.manager.save).not.toHaveBeenCalled();
      expect(f.payments.initiatePayout).not.toHaveBeenCalled();
    },
  );

  it.each([0, 60, 100])(
    'blocks every token origin, with a purchased balance of %s',
    async (withdrawableBalance) => {
      const f = fixture();
      f.state.account.withdrawableBalance = withdrawableBalance;
      await expect(f.service.request('user', f.request)).rejects.toMatchObject({
        status: 403,
        response: TOKEN_WITHDRAWAL_DISABLED,
      });
      expect(f.state.account.balance).toBe(100);
      expect(f.state.account.withdrawableBalance).toBe(withdrawableBalance);
      expect(f.state.account.reservedWithdrawalBalance).toBe(0);
      expect(f.state.ledger).toHaveLength(0);
      expect(f.payments.initiatePayout).not.toHaveBeenCalled();
    },
  );

  it('rejects concurrent retries without reserving tokens or sending money', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.service.request('user', f.request),
      f.service.request('user', f.request),
      f.service.request('user', {
        ...f.request,
        idempotencyKey: 'another-key',
      }),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(f.state.account.reservedWithdrawalBalance).toBe(0);
    expect(f.state.withdrawals).toHaveLength(0);
    expect(f.state.ledger).toHaveLength(0);
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('blocks POST retries of an old withdrawal while preserving its GET status', async () => {
    const f = fixture();
    const withdrawal = seedHistoricalWithdrawal(f);
    const before = structuredClone(f.state);
    await expect(f.service.request('user', f.request)).rejects.toMatchObject({
      status: 403,
      response: TOKEN_WITHDRAWAL_DISABLED,
    });
    expect(f.state).toEqual(before);
    expect((await f.service.get('user', withdrawal.id)).status).toBe(
      'initiated',
    );
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('settles a historical successful payout once and ignores stale failures', async () => {
    const f = fixture();
    const withdrawal = seedHistoricalWithdrawal(f);
    f.state.payments[0].status = PaymentStatus.SUCCEEDED;
    await f.service.callback({} as any);
    await f.service.callback({} as any);
    expect(f.state.account).toMatchObject({
      balance: 60,
      withdrawableBalance: 20,
      reservedWithdrawalBalance: 0,
    });
    f.state.payments[0].status = PaymentStatus.FAILED;
    expect((await f.service.get('user', withdrawal.id)).status).toBe(
      'succeeded',
    );
    expect(f.state.ledger).toHaveLength(1);
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });

  it.each([PaymentStatus.FAILED, PaymentStatus.CANCELLED])(
    'restores purchased tokens once on a verified historical %s payout',
    async (status) => {
      const f = fixture();
      seedHistoricalWithdrawal(f);
      f.state.payments[0].status = status;
      await f.service.callback({} as any);
      await f.service.callback({} as any);
      expect(f.state.account).toMatchObject({
        balance: 100,
        withdrawableBalance: 60,
        reservedWithdrawalBalance: 0,
      });
      expect(f.state.ledger).toHaveLength(2);
      expect(f.state.ledger[1]).toMatchObject({
        amount: 40,
        withdrawableAmount: 40,
        type: 'withdrawal_refund',
      });
      await expect(f.service.request('user', f.request)).rejects.toMatchObject({
        status: 403,
        response: TOKEN_WITHDRAWAL_DISABLED,
      });
    },
  );

  it('keeps an uncertain historical transfer reserved without resending it', async () => {
    const f = fixture();
    const withdrawal = seedHistoricalWithdrawal(f);
    f.state.payments[0].status = PaymentStatus.PENDING;
    f.state.payments[0].orderNumber = null;
    expect((await f.service.get('user', withdrawal.id)).status).toBe('pending');
    await f.service.get('user', withdrawal.id);
    expect(f.state.account.reservedWithdrawalBalance).toBe(40);
    expect(f.payments.checkPaymentStatus).not.toHaveBeenCalled();
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('does not release or resend an orphaned historical reservation automatically', async () => {
    const f = fixture();
    const withdrawal = seedHistoricalWithdrawal(f);
    f.state.payments = [];
    Object.assign(withdrawal, {
      status: 'pending',
      paymentTransactionId: null,
    });
    expect((await f.service.get('user', withdrawal.id)).status).toBe('pending');
    expect(f.state.account.reservedWithdrawalBalance).toBe(40);
    expect(f.state.ledger).toHaveLength(1);
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('holds the wallet for reconciliation on late success after a refunded failure', async () => {
    const f = fixture();
    seedHistoricalWithdrawal(f);
    f.state.payments[0].status = PaymentStatus.FAILED;
    await f.service.callback({} as any);
    f.state.payments[0].status = PaymentStatus.SUCCEEDED;
    await f.service.callback({} as any);
    expect(f.state.account.withdrawalsBlocked).toBe(true);
    expect(f.state.withdrawals[0].status).toBe('review');
    expect(f.state.ledger).toHaveLength(2);
    await expect(
      f.service.request('user', { ...f.request, idempotencyKey: 'new' }),
    ).rejects.toMatchObject({
      status: 403,
      response: TOKEN_WITHDRAWAL_DISABLED,
    });
  });

  it('rejects foreign users and mismatched historical payment amounts', async () => {
    const f = fixture();
    const withdrawal = seedHistoricalWithdrawal(f);
    await expect(f.service.get('other', withdrawal.id)).rejects.toThrow(
      'introuvable',
    );
    f.state.payments[0].amount = 100;
    f.state.payments[0].status = PaymentStatus.SUCCEEDED;
    await expect(f.service.callback({} as any)).rejects.toThrow('incohérente');
    expect(f.state.account.reservedWithdrawalBalance).toBe(40);
  });
});
