import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { of } from 'rxjs';
import {
  FlexPayService,
  type FlexPayTransactionStatus,
} from './flexpay.service';
import { PaymentSettlementRegistry } from './payment-settlement.registry';
import { PaymentsService } from './payments.service';
import type { EntityManager } from 'typeorm';
import { PaymentsController } from './payments.controller';
import { WalletController } from '../wallet/wallet.controller';
import { WalletService } from '../wallet/wallet.service';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntry } from '../wallet/entities/wallet-ledger-entry.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';

// Real payment service + settlement registry; no provider/HTTP/database access.
function fixture(orderInReferenceOnly = false) {
  let payment: PaymentTransaction = Object.assign(new PaymentTransaction(), {
    id: 'synthetic-payment',
    userId: 'synthetic-user',
    purpose: PaymentPurpose.WALLET_TOP_UP,
    relatedEntityType: 'wallet_top_up',
    relatedEntityId: 'synthetic-user',
    provider: PaymentProvider.FLEXPAY,
    method: PaymentMethod.MOBILE_MONEY,
    reference: 'SYNTHETICREF',
    orderNumber: 'SYNTHETICORDER',
    amount: 300,
    currency: 'CDF',
    tokenQuantity: 30,
    status: PaymentStatus.INITIATED,
  });
  const proof = {
    code: '0',
    transaction: {
      status: '0',
      reference: payment.reference,
      orderNumber: payment.orderNumber,
      amount: '300',
      currency: 'CDF',
    },
  };
  if (orderInReferenceOnly) {
    proof.transaction.reference = payment.orderNumber!;
    delete (proof.transaction as Partial<typeof proof.transaction>).orderNumber;
  }
  const manager = {
    transaction: (work: (manager: unknown) => Promise<unknown>) =>
      work(manager),
    findOne: () => Promise.resolve({ ...payment }),
    save: (_entity: unknown, candidate: PaymentTransaction) => {
      payment = { ...candidate };
      return Promise.resolve({ ...payment });
    },
  };
  const repo = {
    manager,
    findOne: jest.fn(() => Promise.resolve({ ...payment })),
  };
  const registry = new PaymentSettlementRegistry();
  const credited = jest.fn(() => Promise.resolve());
  registry.register(PaymentPurpose.WALLET_TOP_UP, credited);
  // Exercise the real HTTP-response normalization, with only the transport mocked.
  const http = { get: jest.fn(() => of({ data: proof })), post: jest.fn() };
  const flexPay = new FlexPayService(
    http as never,
    {
      get: (key: string) =>
        key === 'FLEXPAY_TOKEN' ? 'synthetic-token' : undefined,
    } as never,
  );
  const provider = {
    checkTransaction: jest.fn((order: string) =>
      flexPay.checkTransaction(order),
    ),
    isSuccessfulCode: (code: string | number | null | undefined) =>
      flexPay.isSuccessfulCode(code),
    isSuccessfulTransaction: (
      tx: FlexPayTransactionStatus | null | undefined,
    ) => flexPay.isSuccessfulTransaction(tx),
  };
  const service = new PaymentsService(
    repo as never,
    { get: () => undefined } as never,
    provider as never,
    {} as never,
    registry,
  );
  const callback = {
    code: '0',
    reference: payment.reference,
    orderNumber: 'SYNTHETICORDER',
  };
  const callbackCall = () => service.handleFlexPayCallback(callback);
  return {
    service,
    registry,
    credited,
    provider,
    http,
    proof,
    repo,
    callback,
    callbackCall,
    get payment() {
      return payment;
    },
  };
}

function attachWallet(f: ReturnType<typeof fixture>) {
  let account = Object.assign(new WalletAccount(), {
    id: 'synthetic-wallet',
    userId: f.payment.userId,
    type: WalletAccountType.POINTS,
    balance: 20,
    withdrawableBalance: 0,
    reservedCashCommissionBalance: 0,
    currency: 'PTS',
  });
  let entries: WalletLedgerEntry[] = [];
  let tail = Promise.resolve();
  let failNextEntry = false;
  // Transaction simulation with serialized copies/commit. This does not test PostgreSQL locks.
  const dataSource = {
    transaction: (work: (manager: EntityManager) => Promise<unknown>) => {
      const result = tail.then(async () => {
        let draft = { ...account };
        const draftEntries = [...entries];
        const manager = {
          findOne: (entity: unknown) =>
            Promise.resolve(
              entity === WalletAccount ? draft : (draftEntries[0] ?? null),
            ),
          create: <T extends object>(
            entity: new () => T,
            data: Partial<T>,
          ): T => Object.assign(new entity(), data),
          save: (value: WalletAccount | WalletLedgerEntry) => {
            if ('balance' in value) draft = { ...value };
            else {
              if (failNextEntry) {
                failNextEntry = false;
                throw new Error('Synthetic ledger write failure');
              }
              draftEntries.push({ ...value });
            }
            return Promise.resolve(value);
          },
        };
        const value = await work(manager as never);
        account = draft;
        entries = draftEntries;
        return value;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const wallet = new WalletService(
    { findOne: () => Promise.resolve({ ...account }) } as never,
    { findOne: () => Promise.resolve(entries[0] ?? null) } as never,
    {} as never,
    dataSource as never,
    { get: () => undefined } as never,
    f.service,
  );
  wallet.onModuleInit();
  return {
    wallet,
    generic: new PaymentsController(f.service, {} as never, {} as never),
    specific: new WalletController(wallet, {} as never),
    get account() {
      return account;
    },
    get entries() {
      return entries;
    },
    failLedgerOnce: () => {
      failNextEntry = true;
    },
  };
}

beforeEach(() => {
  for (const method of ['warn', 'log'] as const) {
    jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

describe('FlexPay top-up settlement from generic routes', () => {
  it('awaits wallet settlement after persisting independently verified provider success', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.credited.mockImplementationOnce(() => {
      expect(f.payment.status).toBe(PaymentStatus.SUCCEEDED);
      expect(f.payment.rawCheckResponse).toEqual(f.proof);
      return gate;
    });
    let completed = false;
    const callback = f.callbackCall().then((result) => {
      completed = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.credited).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    release();
    expect((await callback).status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('propagates settlement failure without discarding success, then retries through a terminal status read', async () => {
    const f = fixture();
    f.credited.mockRejectedValueOnce(
      new ServiceUnavailableException('Synthetic wallet outage'),
    );
    await expect(f.callbackCall()).rejects.toThrow('Synthetic wallet outage');
    expect(f.payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(f.payment.rawCheckResponse).toEqual(f.proof);
    expect(
      (
        await f.service.checkPaymentStatus(
          f.payment.orderNumber!,
          f.payment.userId!,
        )
      ).status,
    ).toBe(PaymentStatus.SUCCEEDED);
    expect(f.credited).toHaveBeenCalledTimes(2);
    expect(f.provider.checkTransaction).toHaveBeenCalledTimes(1);
    expect(f.repo.findOne).toHaveBeenLastCalledWith({
      where: [
        { orderNumber: 'SYNTHETICORDER', userId: 'synthetic-user' },
        {
          reference: 'SYNTHETICORDER',
          purpose: PaymentPurpose.WALLET_TOP_UP,
          userId: 'synthetic-user',
        },
      ],
      order: { createdAt: 'DESC' },
    });
  });

  it('settles when the status read discovers success before the callback arrives', async () => {
    const f = fixture();
    expect(
      (
        await f.service.checkPaymentStatus(
          f.payment.orderNumber!,
          f.payment.userId!,
        )
      ).status,
    ).toBe(PaymentStatus.SUCCEEDED);
    expect(f.credited).toHaveBeenCalledTimes(1);
  });

  it('lets the durable worker recover a failed immediate settlement', async () => {
    const f = fixture();
    f.credited.mockRejectedValueOnce(
      new Error('Synthetic settlement interruption'),
    );
    await expect(f.callbackCall()).rejects.toThrow(
      'Synthetic settlement interruption',
    );
    expect(await f.service.reconcilePayment(f.payment.id)).toBe(true);
    expect(f.credited).toHaveBeenCalledTimes(2);
    expect(f.provider.checkTransaction).toHaveBeenCalledTimes(1);
  });

  it('retries the saved success even if a late callback announces failure', async () => {
    const f = fixture();
    await f.callbackCall();
    await f.service.handleFlexPayCallback({ ...f.callback, code: '1' });
    expect(f.payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(f.credited).toHaveBeenCalledTimes(2);
    expect(f.provider.checkTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable wallet handler and retains the verified payment for retry', async () => {
    const f = fixture();
    f.registry.register(PaymentPurpose.WALLET_TOP_UP, undefined as never);
    await expect(f.callbackCall()).rejects.toThrow('Finalisation du paiement');
    expect(f.payment.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('rejects a locally succeeded top-up without complete proof after a late negative callback', async () => {
    const f = fixture();
    f.payment.status = PaymentStatus.SUCCEEDED;
    await expect(
      f.service.handleFlexPayCallback({ ...f.callback, code: '1' }),
    ).rejects.toThrow('La recharge doit être vérifiée');
    expect(f.credited).not.toHaveBeenCalled();
  });

  it.each(['2', '1'])(
    'does not credit an authoritative pending/failed provider result (%s)',
    async (status) => {
      const f = fixture();
      f.proof.transaction.status = status;
      await f.callbackCall();
      expect(f.credited).not.toHaveBeenCalled();
      expect(f.payment.status).not.toBe(PaymentStatus.SUCCEEDED);
    },
  );

  it.each(['currency', 'amount', 'reference', 'orderNumber'] as const)(
    'does not credit incomplete provider proof: %s',
    async (field) => {
      const f = fixture();
      delete (f.proof.transaction as Partial<typeof f.proof.transaction>)[
        field
      ];
      await f.callbackCall();
      expect(f.credited).not.toHaveBeenCalled();
      expect(f.payment.status).toBe(PaymentStatus.INITIATED);
    },
  );

  it.each([
    { currency: 'USD' },
    { amount: '1' },
    { reference: 'OTHER' },
    { orderNumber: 'OTHER' },
  ])('does not credit mismatched provider proof: %p', async (patch) => {
    const f = fixture();
    Object.assign(f.proof.transaction, patch);
    await f.callbackCall();
    expect(f.credited).not.toHaveBeenCalled();
    expect(f.payment.status).toBe(PaymentStatus.INITIATED);
  });

  it('keeps a provider timeout pending instead of trusting the callback', async () => {
    const f = fixture();
    f.provider.checkTransaction.mockRejectedValueOnce(
      new Error('Synthetic timeout'),
    );
    expect((await f.callbackCall()).status).toBe(PaymentStatus.INITIATED);
    expect(f.credited).not.toHaveBeenCalled();
  });

  it.each([
    PaymentPurpose.TRIP_BOOKING,
    PaymentPurpose.SUBSCRIPTION_PRO,
    PaymentPurpose.GENERIC,
  ])(
    'does not add an immediate settlement to other FlexPay purposes: %s',
    async (purpose) => {
      const f = fixture();
      f.payment.purpose = purpose;
      const other = jest.fn();
      f.registry.register(purpose, other);
      await f.callbackCall();
      expect(f.credited).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
    },
  );
});

describe('FlexPay callbacks integrated with the real wallet handler', () => {
  it.each([false, true])(
    'credits once across generic/specific callbacks, status reads and the worker (order in reference only: %s)',
    async (referenceOnly) => {
      const f = fixture(referenceOnly),
        w = attachWallet(f);
      await w.generic.handleFlexPayCallback(f.callback);
      expect(w.account.balance).toBe(50); // Existing 20 + purchased 30, not the 300 CDF amount.
      await w.generic.handleFlexPayCallback(f.callback);
      await w.specific.handleTopUpCallback(f.callback);
      const result = await w.specific.checkTopUpStatus(
        { user: { userId: f.payment.userId } },
        f.payment.orderNumber!,
      );
      expect(result.payment.status).toBe(PaymentStatus.SUCCEEDED);
      expect(result.account.balance).toBe(50);
      expect(await f.service.reconcilePayment(f.payment.id)).toBe(true);
      expect(w.entries).toHaveLength(1);
      expect(w.entries[0]).toMatchObject({
        paymentTransactionId: f.payment.id,
        amount: 30,
        balanceAfter: 50,
      });
      expect(f.provider.checkTransaction).toHaveBeenCalledWith(
        'SYNTHETICORDER',
      );
      expect(f.http.post).not.toHaveBeenCalled();
      expect(f.payment.orderNumber).toBe('SYNTHETICORDER');
      expect(f.payment.rawCheckResponse).toEqual(f.proof);
      if (referenceOnly) {
        expect(f.payment.rawCheckResponse!.transaction).not.toHaveProperty(
          'orderNumber',
        );
      }
    },
  );

  it.each([false, true])(
    'recovers a simulated ledger failure without a new charge (order in reference only: %s)',
    async (referenceOnly) => {
      const f = fixture(referenceOnly),
        w = attachWallet(f);
      w.failLedgerOnce();
      await expect(w.generic.handleFlexPayCallback(f.callback)).rejects.toThrow(
        'Synthetic ledger write failure',
      );
      expect(w.account.balance).toBe(20);
      expect(w.entries).toHaveLength(0);
      expect(f.payment.status).toBe(PaymentStatus.SUCCEEDED);
      const result = await w.wallet.checkTopUpPaymentStatus(
        f.payment.userId!,
        f.payment.orderNumber!,
      );
      expect(result.account.balance).toBe(50);
      expect(w.entries).toHaveLength(1);
      expect(f.provider.checkTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'deduplicates overlapping settlements with serialized wallet transactions (order in reference only: %s)',
    async (referenceOnly) => {
      const f = fixture(referenceOnly),
        w = attachWallet(f);
      await Promise.all([
        w.generic.handleFlexPayCallback(f.callback),
        w.specific.handleTopUpCallback(f.callback),
        f.service.reconcilePayment(f.payment.id),
        w.wallet.checkTopUpPaymentStatus(
          f.payment.userId!,
          f.payment.orderNumber!,
        ),
      ]);
      expect(w.account.balance).toBe(50);
      expect(w.entries).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'keeps the legacy token quantity without repricing (order in reference only: %s)',
    async (referenceOnly) => {
      const f = fixture(referenceOnly),
        w = attachWallet(f);
      f.payment.tokenQuantity = null;
      f.payment.description = 'Achat de 30 jetons Zwanga';
      await w.generic.handleFlexPayCallback(f.callback);
      expect(w.account.balance).toBe(50);
      expect(w.entries[0].amount).toBe(30);
    },
  );

  it.each([false, true])(
    'does not return success with a missing token quantity (order in reference only: %s)',
    async (referenceOnly) => {
      const f = fixture(referenceOnly),
        w = attachWallet(f);
      f.payment.tokenQuantity = null;
      await expect(w.generic.handleFlexPayCallback(f.callback)).rejects.toThrow(
        'quantité de jetons',
      );
      expect(f.payment.status).toBe(PaymentStatus.SUCCEEDED);
      expect(w.account.balance).toBe(20);
      expect(w.entries).toHaveLength(0);
    },
  );

  it('reconciles an initiated historical top-up with the production response shape without reinitiating payment', async () => {
    const f = fixture(true),
      w = attachWallet(f);
    expect(await f.service.reconcilePayment(f.payment.id)).toBe(true);
    expect(f.payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(w.account.balance).toBe(50);
    expect(await f.service.reconcilePayment(f.payment.id)).toBe(true);
    expect(w.entries).toHaveLength(1);
    expect(f.provider.checkTransaction).toHaveBeenCalledTimes(1);
    expect(f.http.post).not.toHaveBeenCalled();
  });

  it.each([
    { reference: 'SYNTHETICREF' },
    { reference: 'OTHER' },
    { reference: '' },
    { orderNumber: 'OTHER' },
    { orderNumber: '' },
    { amount: '1' },
    { amount: '' },
    { currency: 'USD' },
    { currency: '' },
  ])(
    'does not credit an inconsistent order-as-reference result: %p',
    async (patch) => {
      const f = fixture(true),
        w = attachWallet(f);
      Object.assign(f.proof.transaction, patch);
      await expect(
        f.service.checkPaymentStatus('SYNTHETICORDER', 'synthetic-user'),
      ).rejects.toThrow();
      expect(f.payment.status).toBe(PaymentStatus.INITIATED);
      expect(w.account.balance).toBe(20);
      expect(w.entries).toHaveLength(0);
      expect(f.http.post).not.toHaveBeenCalled();
    },
  );
});
