import { BadRequestException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import {
  SubscriptionPlan,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { SubscriptionsService } from './subscriptions.service';

describe('SubscriptionsService points payments', () => {
  let subscriptionRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
  };
  let documentFundingRequestRepository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let userRepository: { findOne: jest.Mock };
  let configService: { get: jest.Mock };
  let cacheService: { del: jest.Mock };
  let paymentsService: {
    getClientPaymentMessage: jest.Mock;
    formatLogPayload: jest.Mock;
  };
  let walletService: {
    getPointsCurrency: jest.Mock;
    convertMoneyToPoints: jest.Mock;
    payForSubscription: jest.Mock;
  };
  let service: SubscriptionsService;

  const driver = {
    id: 'driver-1',
    isDriver: true,
    role: 'driver',
  };

  beforeEach(() => {
    subscriptionRepository = {
      create: jest.fn((payload: unknown) => payload),
      save: jest.fn((payload: any) =>
        Promise.resolve({
          id: payload.id ?? 'subscription-1',
          ...payload,
        }),
      ),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    documentFundingRequestRepository = {
      create: jest.fn((payload: unknown) => payload),
      save: jest.fn((payload: unknown) => Promise.resolve(payload)),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue(driver),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'SUBSCRIPTION_PRO_PRICE') {
          return 5000;
        }
        if (key === 'SUBSCRIPTION_PRO_CURRENCY') {
          return 'CDF';
        }
        return undefined;
      }),
    };
    cacheService = { del: jest.fn().mockResolvedValue(undefined) };
    paymentsService = {
      getClientPaymentMessage: jest.fn().mockReturnValue(null),
      formatLogPayload: jest.fn((payload: unknown) => JSON.stringify(payload)),
    };
    walletService = {
      getPointsCurrency: jest.fn().mockReturnValue('PTS'),
      convertMoneyToPoints: jest.fn((amount: number) => amount / 100),
      payForSubscription: jest.fn().mockResolvedValue({
        id: 'wallet-entry-1',
        amount: -50,
        currency: 'PTS',
      }),
    };

    service = new SubscriptionsService(
      subscriptionRepository as any,
      documentFundingRequestRepository as any,
      userRepository as any,
      configService as any,
      cacheService as any,
      paymentsService as any,
      walletService as any,
    );
  });

  it('lists points as a subscription payment option', () => {
    expect(service.getPlans()).toEqual([
      expect.objectContaining({
        paymentMethods: [
          PaymentMethod.MOBILE_MONEY,
          PaymentMethod.CARD,
          'points',
        ],
        pointsAmount: 50,
        pointsCurrency: 'PTS',
      }),
    ]);
    expect(walletService.convertMoneyToPoints).toHaveBeenCalledWith(
      5000,
      'CDF',
    );
  });

  it('activates a Pro subscription paid with wallet points', async () => {
    const result = await service.subscribeWithPoints('driver-1', {
      plan: SubscriptionPlan.PRO,
    });

    expect(walletService.payForSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'subscription-1',
        userId: 'driver-1',
        amount: 50,
        currency: 'PTS',
      }),
      50,
    );
    expect(subscriptionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SubscriptionStatus.ACTIVE,
        paymentReference: 'POINTS-wallet-entry-1',
        paymentTransactionId: null,
      }),
    );
    expect(result.subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(result.walletEntry?.id).toBe('wallet-entry-1');
    expect(result.payment).toEqual(
      expect.objectContaining({
        status: PaymentStatus.SUCCEEDED,
        reference: 'POINTS-wallet-entry-1',
        amount: 50,
        currency: 'PTS',
      }),
    );
  });

  it('marks the subscription payment failed when points are insufficient', async () => {
    walletService.payForSubscription.mockRejectedValue(
      new BadRequestException(
        'Solde de points insuffisant pour payer cet abonnement',
      ),
    );

    await expect(
      service.subscribeWithPoints('driver-1', {
        plan: SubscriptionPlan.PRO,
      }),
    ).rejects.toThrow('Solde de points insuffisant');

    expect(subscriptionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'subscription-1',
        status: SubscriptionStatus.PAYMENT_FAILED,
      }),
    );
  });
});
