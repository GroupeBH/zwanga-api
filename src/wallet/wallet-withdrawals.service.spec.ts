import { BadRequestException } from '@nestjs/common';
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

describe('purchased-token withdrawals', () => {
  it('reserves only purchased tokens and submits once on concurrent double tap and retry', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.service.request('user', f.request),
      f.service.request('user', f.request),
    ]);
    expect(first.id).toBe(second.id);
    await f.service.request('user', f.request);
    expect(f.payments.initiatePayout).toHaveBeenCalledTimes(1);
    expect(f.state.account).toMatchObject({
      balance: 60,
      withdrawableBalance: 20,
      reservedWithdrawalBalance: 40,
    });
    expect(f.state.ledger).toHaveLength(1);
    expect(f.payments.initiatePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: PaymentPurpose.WALLET_PAYOUT,
        amount: 4000,
        phone: '243891234567',
      }),
    );
  });
  it('rejects competing withdrawals exceeding the purchased balance, not the total wallet', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.service.request('user', f.request),
      f.service.request('user', {
        ...f.request,
        idempotencyKey: '9663310e-88fa-4bcc-9ebf-394c40bf462f',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(f.payments.initiatePayout).toHaveBeenCalledTimes(1);
    expect(f.state.account.withdrawableBalance).toBe(20);
  });
  it.each(['kyc', 'active'])(
    'requires an active account and approved KYC (%s)',
    async (field) => {
      const f = fixture();
      f.state[field] = false;
      await expect(f.service.request('user', f.request)).rejects.toThrow();
      expect(f.state.ledger).toHaveLength(0);
      expect(f.payments.initiatePayout).not.toHaveBeenCalled();
    },
  );
  it('refuses all-loyalty balances and blocks rollouts by default', async () => {
    const f = fixture();
    f.state.account.withdrawableBalance = 0;
    await expect(f.service.request('user', f.request)).rejects.toThrow(
      'retirables insuffisant',
    );
    f.config.get.mockReturnValue(undefined);
    await expect(f.service.request('user', f.request)).rejects.toThrow(
      'activé',
    );
    expect(f.state.ledger).toHaveLength(0);
  });
  it('does not change destination or amount under an existing idempotency key', async () => {
    const f = fixture();
    await f.service.request('user', f.request);
    await expect(
      f.service.request('user', { ...f.request, tokens: 41 }),
    ).rejects.toThrow('autre montant');
    await expect(
      f.service.request('user', { ...f.request, phone: '+243899999999' }),
    ).rejects.toThrow('autre montant');
    expect(f.payments.initiatePayout).toHaveBeenCalledTimes(1);
  });
  it('settles a successful payout once and ignores stale failure notifications', async () => {
    const f = fixture();
    const withdrawal = await f.service.request('user', f.request);
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
  });
  it('restores purchased origin once on a verified failure', async () => {
    const f = fixture();
    await f.service.request('user', f.request);
    f.state.payments[0].status = PaymentStatus.FAILED;
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
  });
  it('keeps unknown delivery reserved even after an app restart/retry', async () => {
    const f = fixture();
    f.payments.initiatePayout.mockImplementation(async (input) => {
      f.state.payments.push({
        ...input,
        id: 'payment',
        status: PaymentStatus.PENDING,
        orderNumber: null,
      });
      throw new Error('Lost response');
    });
    const first = await f.service.request('user', f.request);
    expect(first.status).toBe('pending');
    await f.service.request('user', f.request);
    expect(f.state.account.reservedWithdrawalBalance).toBe(40);
    expect(f.payments.initiatePayout).toHaveBeenCalledTimes(1);
  });
  it('releases only a proven unsent failure and never resubmits that key', async () => {
    const f = fixture();
    f.payments.initiatePayout.mockRejectedValue(
      new BadRequestException('Not configured'),
    );
    await expect(f.service.request('user', f.request)).rejects.toThrow(
      'Not configured',
    );
    expect(f.state.account).toMatchObject({
      balance: 100,
      withdrawableBalance: 60,
      reservedWithdrawalBalance: 0,
    });
    expect((await f.service.request('user', f.request)).status).toBe('failed');
    expect(f.payments.initiatePayout).toHaveBeenCalledTimes(1);
  });
  it('holds the wallet for manual reconciliation on success after a refunded failure', async () => {
    const f = fixture();
    await f.service.request('user', f.request);
    f.state.payments[0].status = PaymentStatus.FAILED;
    await f.service.callback({} as any);
    f.state.payments[0].status = PaymentStatus.SUCCEEDED;
    await f.service.callback({} as any);
    expect(f.state.account.withdrawalsBlocked).toBe(true);
    expect(f.state.withdrawals[0].status).toBe('review');
    expect(f.state.ledger).toHaveLength(2);
    await expect(
      f.service.request('user', { ...f.request, idempotencyKey: 'new' }),
    ).rejects.toThrow('vérification');
  });
  it('rejects foreign users and mismatched payment amounts without changing balances', async () => {
    const f = fixture();
    const withdrawal = await f.service.request('user', f.request);
    await expect(f.service.get('other', withdrawal.id)).rejects.toThrow(
      'introuvable',
    );
    f.state.payments[0].amount = 100;
    f.state.payments[0].status = PaymentStatus.SUCCEEDED;
    await expect(f.service.callback({} as any)).rejects.toThrow('incohérente');
    expect(f.state.account.reservedWithdrawalBalance).toBe(40);
  });
});
