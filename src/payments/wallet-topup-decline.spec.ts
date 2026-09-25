import { Logger } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import {
  PaymentStatus,
  type PaymentTransaction,
} from './entities/payment-transaction.entity';
import type { FlexPayTransactionStatus } from './flexpay.service';
import { WalletService } from '../wallet/wallet.service';
import { hasVerifiedWalletTopUpProof } from './wallet-topup-proof';

// Synthetic identifiers only. Repositories and provider reads never access real services.
function environment(providerPatch: Partial<FlexPayTransactionStatus> = {}) {
  const payment = {
    id: 'payment-test',
    userId: 'passenger-test',
    purpose: 'wallet_top_up',
    relatedEntityType: 'wallet_top_up',
    relatedEntityId: 'passenger-test',
    method: 'mobile_money',
    reference: 'WALTEST',
    orderNumber: 'ORDERTEST',
    status: PaymentStatus.INITIATED,
    amount: 1400,
    currency: 'CDF',
    paidAt: null,
  } as unknown as PaymentTransaction;
  const provider = {
    reference: 'ORDERTEST',
    orderNumber: null,
    status: '4',
    amount: '1400.0',
    amountCustomer: '1435.0',
    currency: 'CDF',
    createdAt: null,
    ...providerPatch,
  };
  const raw = {
    code: '0',
    message: 'Transaction was declined by the operator',
    transaction: { ...provider },
  };
  // Actual check payload omits orderNumber; normalization represents it as null.
  if (provider.orderNumber === null)
    delete (raw.transaction as Partial<typeof provider>).orderNumber;
  const result = { ...raw, transaction: provider, raw };
  const repository = {
    findOne: jest.fn().mockImplementation(() => Promise.resolve(payment)),
    save: jest
      .fn()
      .mockImplementation((value: PaymentTransaction) =>
        Promise.resolve(value),
      ),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const flexPay = {
    checkTransaction: jest
      .fn()
      .mockImplementation(() => Promise.resolve(result)),
    isSuccessfulCode: (code: string) => code === '0',
    isSuccessfulTransaction: (value: FlexPayTransactionStatus) =>
      value.status === '0',
  };
  const service = new PaymentsService(
    repository as never,
    config as never,
    flexPay as never,
    { isConfigured: () => false } as never,
    { register: jest.fn(), apply: jest.fn() } as never,
  );
  return { payment, result, repository, config, flexPay, service };
}

describe('confirmed FlexPay top-up refusals', () => {
  beforeEach(() => {
    for (const method of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns failed when status 4 explicitly says declined and reference contains the checked order', async () => {
    const env = environment();
    const result = await env.service.checkPaymentStatus(
      'ORDERTEST',
      'passenger-test',
    );
    expect(result.status).toBe(PaymentStatus.FAILED);
    expect(result.providerStatusCode).toBe('4');
    expect(result.orderNumber).toBe('ORDERTEST');
    expect(result.providerMessage).toBe(
      'Paiement refusé par l’opérateur. Aucun montant confirmé.',
    );
    expect(result.paidAt).toBeNull();
    expect(hasVerifiedWalletTopUpProof(result)).toBe(false);
    expect(env.flexPay.checkTransaction).toHaveBeenCalledWith('ORDERTEST');
    await env.service.checkPaymentStatus('ORDERTEST', 'passenger-test');
    expect(env.flexPay.checkTransaction).toHaveBeenCalledTimes(1);
  });

  it('passes a failed top-up through the wallet response without crediting or accessing the ledger', async () => {
    const env = environment();
    const account = {
      id: 'wallet-test',
      userId: 'passenger-test',
      balance: 0,
      currency: 'PTS',
    };
    const accounts = { findOne: jest.fn().mockResolvedValue(account) };
    const ledger = { findOne: jest.fn(), save: jest.fn() };
    const dataSource = { transaction: jest.fn() };
    const wallet = new WalletService(
      accounts as never,
      ledger as never,
      {} as never,
      dataSource as never,
      env.config as never,
      env.service,
    );
    const response = await wallet.checkTopUpPaymentStatus(
      'passenger-test',
      'ORDERTEST',
    );
    expect(response.payment.status).toBe(PaymentStatus.FAILED);
    expect(response.payment.message).toBe(
      'Paiement refusé par l’opérateur. Aucun montant confirmé.',
    );
    expect(response.account.balance).toBe(0);
    expect(ledger.findOne).not.toHaveBeenCalled();
    expect(ledger.save).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { reference: null, orderNumber: 'ORDERTEST' },
    { reference: 'WALTEST', amount: null, currency: null },
    { reference: 'ORDERTEST', amount: null, currency: null },
  ])(
    'accepts a correlated refusal without requiring credit proof: %p',
    async (patch) => {
      const env = environment(patch);
      expect(
        (await env.service.checkPaymentStatus('ORDERTEST', 'passenger-test'))
          .status,
      ).toBe(PaymentStatus.FAILED);
    },
  );

  it.each([
    { reference: 'OTHER' },
    { orderNumber: 'OTHER' },
    { reference: null, orderNumber: null },
    { reference: 'OTHER', orderNumber: 'ORDERTEST' },
    { amount: '1500' },
    { currency: 'USD' },
  ])(
    'does not release an unrelated or inconsistent refusal: %p',
    async (patch) => {
      const env = environment(patch);
      await expect(
        env.service.checkPaymentStatus('ORDERTEST', 'passenger-test'),
      ).rejects.toThrow();
      expect(env.repository.save).not.toHaveBeenCalled();
      expect(env.payment.status).toBe(PaymentStatus.INITIATED);
    },
  );

  it.each(['0', '2', '4'])(
    'keeps complete-proof requirements for unconfirmed refusal/status %s',
    async (status) => {
      const env = environment({ status });
      env.result.message = 'Transaction found';
      await expect(
        env.service.checkPaymentStatus('ORDERTEST', 'passenger-test'),
      ).rejects.toThrow('confirmation FlexPay complète');
      expect(env.repository.save).not.toHaveBeenCalled();
    },
  );

  it('never treats a failed check envelope as an operator refusal', async () => {
    const env = environment();
    env.result.code = '1';
    const payment = await env.service.checkPaymentStatus(
      'ORDERTEST',
      'passenger-test',
    );
    expect(payment.status).toBe(PaymentStatus.INITIATED);
  });

  it('preserves complete positive proof and cannot convert the negative proof into a credit', async () => {
    const env = environment({
      status: '0',
      reference: 'WALTEST',
      orderNumber: 'ORDERTEST',
    });
    env.result.message = 'Transaction found';
    const paid = await env.service.checkPaymentStatus(
      'ORDERTEST',
      'passenger-test',
    );
    expect(paid.status).toBe(PaymentStatus.SUCCEEDED);
    expect(hasVerifiedWalletTopUpProof(paid)).toBe(true);
  });
});
