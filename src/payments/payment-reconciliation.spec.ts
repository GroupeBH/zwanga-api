import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentsService } from './payments.service';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from './entities/payment-transaction.entity';

describe('Durable deposit reconciliation', () => {
  it('preserves success when a concurrent provider request finishes late with pending state', async () => {
    const stored = {
      id: 'payment',
      provider: PaymentProvider.FLEXPAY,
      status: PaymentStatus.SUCCEEDED,
      purpose: PaymentPurpose.GENERIC,
    };
    const manager = { findOne: jest.fn(async () => stored), save: jest.fn() };
    const service = Object.create(PaymentsService.prototype);
    service.paymentTransactionRepository = {
      manager: { transaction: (work: any) => work(manager) },
    };
    expect(
      await service.saveFlexPayDepositCheck({
        ...stored,
        status: PaymentStatus.INITIATED,
      }),
    ).toBe(stored);
    expect(manager.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(manager.save).not.toHaveBeenCalled();
  });
  function workerFixture(result: boolean | Error) {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        [
          {
            paymentId: 'payment',
            attempts: 2,
            revision: 3,
            createdAt: new Date(),
          },
        ],
        1,
      ])
      .mockResolvedValue([[], 0]);
    const reconcilePayment =
      result instanceof Error
        ? jest.fn().mockRejectedValue(result)
        : jest.fn().mockResolvedValue(result);
    const worker = new PaymentReconciliationService(
      { query } as never,
      { reconcilePayment } as never,
    );
    return { worker, query, reconcilePayment };
  }
  it('uses fenced leases and completes only after settlement', async () => {
    const f = workerFixture(true);
    await f.worker.reconcile();
    const [claimSql, [lease]] = f.query.mock.calls[0];
    expect(claimSql).toContain('SKIP LOCKED');
    expect(claimSql).toContain('LIMIT 5');
    expect(f.query.mock.calls[1][0]).toContain('revision = $6');
    expect(f.query.mock.calls[1][1]).toEqual([
      'payment',
      lease,
      true,
      240,
      null,
      3,
    ]);
  });
  it.each([false, new Error('provider secret must not be stored')])(
    'retains pending/failed work for retry',
    async (result) => {
      const f = workerFixture(result);
      await f.worker.reconcile();
      expect(f.query.mock.calls[1][1][2]).toBe(false);
      expect(JSON.stringify(f.query.mock.calls)).not.toContain(
        'provider secret',
      );
    },
  );
  function paymentFixture(status: PaymentStatus) {
    const payment = {
      id: 'payment',
      provider: PaymentProvider.FLEXPAY,
      purpose: PaymentPurpose.SUBSCRIPTION_PRO,
      status,
      orderNumber: 'order',
    };
    const service = Object.create(PaymentsService.prototype);
    Object.assign(service, {
      paymentTransactionRepository: { findOne: jest.fn(async () => payment) },
      checkTransactionAndApply: jest.fn(async () => payment),
      settlementRegistry: { apply: jest.fn(async () => undefined) },
    });
    return { service, payment };
  }
  it('does not credit a pending provider result', async () => {
    const { service } = paymentFixture(PaymentStatus.INITIATED);
    expect(await service.reconcileFlexPayDeposit('payment')).toBe(false);
    expect(service.settlementRegistry.apply).not.toHaveBeenCalled();
  });
  it('retries settlement even if a previous callback already saved success', async () => {
    const { service } = paymentFixture(PaymentStatus.SUCCEEDED);
    service.settlementRegistry.apply.mockRejectedValueOnce(
      new Error('domain unavailable'),
    );
    await expect(service.reconcileFlexPayDeposit('payment')).rejects.toThrow(
      'domain unavailable',
    );
    expect(await service.reconcileFlexPayDeposit('payment')).toBe(true);
    expect(service.checkTransactionAndApply).not.toHaveBeenCalled();
  });
  it('never applies the deposit recovery to payouts', async () => {
    const { service, payment } = paymentFixture(PaymentStatus.SUCCEEDED);
    payment.purpose = PaymentPurpose.DRIVER_PAYOUT;
    expect(await service.reconcileFlexPayDeposit('payment')).toBe(true);
    expect(service.settlementRegistry.apply).not.toHaveBeenCalled();
  });
  it.each([PaymentPurpose.DRIVER_PAYOUT, PaymentPurpose.REFERRAL_PAYOUT, PaymentPurpose.WALLET_TOP_UP])(
    'the new durable recovery applies terminal PawaPay %s settlements', async purpose => {
      const { service, payment } = paymentFixture(PaymentStatus.SUCCEEDED);
      payment.provider = PaymentProvider.PAWAPAY;
      payment.purpose = purpose;
      // Top-up proof is validated separately before it can be applied.
      if (purpose === PaymentPurpose.WALLET_TOP_UP) {
        payment.status = PaymentStatus.FAILED;
      }
      expect(await service.reconcilePayment(payment.id)).toBe(true);
      expect(service.settlementRegistry.apply).toHaveBeenCalledWith(payment);
    },
  );
  it('honors a paused PawaPay reconciliation without discarding pending work', async () => {
    const { service, payment } = paymentFixture(PaymentStatus.INITIATED);
    payment.provider = PaymentProvider.PAWAPAY;
    service.configService = { get: () => 'false' };
    service.pawaPayService = { isConfigured: () => true };
    expect(await service.reconcilePayment(payment.id)).toBe(false);
    expect(service.checkTransactionAndApply).not.toHaveBeenCalled();
  });
});
