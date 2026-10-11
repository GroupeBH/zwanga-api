import { SubscriptionsService } from './subscriptions.service';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { PaymentStatus } from '../payments/entities/payment-transaction.entity';

describe('Subscription settlement replay safety', () => {
  function fixture(status: SubscriptionStatus) {
    const current = {
      id: 'subscription',
      userId: 'user',
      status,
      paymentTransactionId: 'payment',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-01-31'),
    };
    const manager = {
      findOne: jest.fn(async (entity: unknown) =>
        entity === Subscription ? { ...current } : { id: 'user' },
      ),
      save: jest.fn(async (_entity: unknown, value: any) =>
        Object.assign(current, value),
      ),
      update: jest.fn(),
    };
    const service = Object.create(SubscriptionsService.prototype);
    Object.assign(service, {
      subscriptionRepository: {
        manager: { transaction: (work: any) => work(manager) },
      },
      walletService: { awardSubscriptionPaymentTokens: jest.fn() },
      referralsService: {
        awardSubscriptionReward: jest.fn(),
        reverseSubscriptionReward: jest.fn(),
      },
      invalidatePremiumCaches: jest.fn(),
      getDocumentFundingLimit: () => 0,
      getDocumentFundingCurrency: () => 'CDF',
      logger: { log: jest.fn() },
    });
    const payment = {
      id: 'payment',
      reference: 'SUB-test',
      status: PaymentStatus.SUCCEEDED,
    };
    return { service, manager, current, payment };
  }
  it('does not extend an already expired subscription', async () => {
    const f = fixture(SubscriptionStatus.EXPIRED);
    const result = await f.service.applyPaymentToSubscription(
      { ...f.current },
      f.payment,
    );
    expect(result.status).toBe(SubscriptionStatus.EXPIRED);
    expect(result.endDate).toEqual(new Date('2026-01-31'));
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('re-reads an activation completed by a concurrent callback instead of resetting dates', async () => {
    const f = fixture(SubscriptionStatus.ACTIVE);
    const result = await f.service.applyPaymentToSubscription(
      { ...f.current, status: SubscriptionStatus.PENDING },
      f.payment,
    );
    expect(result.endDate).toEqual(f.current.endDate);
    expect(f.manager.findOne).toHaveBeenCalledWith(
      Subscription,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.manager.update).not.toHaveBeenCalled();
  });
  it('leaves a superseded paid purchase pending manual regularization, never replacing current Pro', async () => {
    const f = fixture(SubscriptionStatus.CANCELLED);
    await expect(
      f.service.applyPaymentToSubscription({ ...f.current }, f.payment),
    ).rejects.toThrow('régularisation');
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.manager.update).not.toHaveBeenCalled();
    expect(
      f.service.walletService.awardSubscriptionPaymentTokens,
    ).not.toHaveBeenCalled();
  });

  it.each([
    PaymentStatus.INITIATED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ])(
    'does not overwrite a concurrent activation with a stale %s result',
    async (status) => {
      const f = fixture(SubscriptionStatus.ACTIVE);
      const result = await f.service.applyPaymentToSubscription(
        { ...f.current, status: SubscriptionStatus.PENDING },
        { ...f.payment, status },
      );
      expect(result.status).toBe(SubscriptionStatus.ACTIVE);
      expect(result.endDate).toEqual(f.current.endDate);
      expect(f.manager.save).not.toHaveBeenCalled();
      expect(
        f.service.referralsService.reverseSubscriptionReward,
      ).not.toHaveBeenCalled();
    },
  );
});
