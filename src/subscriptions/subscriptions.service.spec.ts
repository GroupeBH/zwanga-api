import { BadRequestException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import { User } from '../users/entities/user.entity';
import {
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
} from './entities/subscription.entity';
import {
  SubscriptionsService,
  kinshasaCalendarMonth,
  parseProSubscriptionMonth,
} from './subscriptions.service';

describe('pro subscription month filter', () => {
  it('bounds the Kinshasa calendar month, end exclusive', () => {
    expect(kinshasaCalendarMonth(new Date('2026-10-13T22:30:00.000Z'))).toEqual({
      from: new Date('2026-10-01T00:00:00+01:00'),
      to: new Date('2026-11-01T00:00:00+01:00'),
    });
    expect(kinshasaCalendarMonth(new Date('2026-10-31T23:30:00.000Z'))).toEqual({
      from: new Date('2026-11-01T00:00:00+01:00'),
      to: new Date('2026-12-01T00:00:00+01:00'),
    });
  });

  it('accepts current, other and all', () => {
    expect(parseProSubscriptionMonth('current')).toBe('current');
    expect(parseProSubscriptionMonth('other')).toBe('other');
    expect(parseProSubscriptionMonth('all')).toBeUndefined();
    expect(parseProSubscriptionMonth('')).toBeUndefined();
    expect(() => parseProSubscriptionMonth('octobre')).toThrow(BadRequestException);
  });
});

describe('SubscriptionsService points payments', () => {
  let subscriptionRepository: {
    manager: any;
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
    awardSubscriptionPaymentTokens: jest.Mock;
    getSubscriptionPaymentRewardTokens: jest.Mock;
  };
  let referralsService: {
    awardSubscriptionReward: jest.Mock;
    reverseSubscriptionReward: jest.Mock;
  };
  let service: SubscriptionsService;

  const driver = {
    id: 'driver-1',
    isDriver: true,
    role: 'driver',
  };

  beforeEach(() => {
    let stored: any;
    subscriptionRepository = {
      manager: {} as any,
      create: jest.fn((payload: unknown) => payload),
      save: jest.fn((payload: any) =>
        Promise.resolve(stored = {
          id: payload.id ?? 'subscription-1',
          ...payload,
        }),
      ),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      transaction: async (work: any) => work(manager),
      findOne: async (entity: unknown, options: any) => {
        if (entity === User) return driver;
        if (entity === Subscription && stored &&
            (!options.where.status || options.where.status === stored.status)) return { ...stored };
        return null;
      },
      find: async () => [],
      create: (_entity: unknown, value: any) => subscriptionRepository.create(value),
      update: async (_entity: unknown, where: any, patch: any) => subscriptionRepository.update(where, patch),
      save: async (_entity: unknown, value: any) => subscriptionRepository.save(value),
    };
    subscriptionRepository.manager = manager;
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
      convertMoneyToPoints: jest.fn((amount: number) => amount / 10),
      payForSubscription: jest.fn().mockResolvedValue({
        id: 'wallet-entry-1',
        amount: -500,
        currency: 'PTS',
      }),
      awardSubscriptionPaymentTokens: jest.fn().mockResolvedValue({
        id: 'subscription-reward-1',
        amount: 25,
        currency: 'PTS',
      }),
      getSubscriptionPaymentRewardTokens: jest.fn().mockReturnValue(25),
    };
    referralsService = {
      awardSubscriptionReward: jest.fn().mockResolvedValue(null),
      reverseSubscriptionReward: jest.fn().mockResolvedValue(null),
    };

    service = new SubscriptionsService(
      subscriptionRepository as any,
      documentFundingRequestRepository as any,
      userRepository as any,
      configService as any,
      cacheService as any,
      paymentsService as any,
      walletService as any,
      referralsService as any,
    );
  });

  it('advertises 5000 CDF, 30 days and 5% even if legacy pricing variables remain configured', () => {
    configService.get.mockImplementation((key: string) => ({ SUBSCRIPTION_PRO_PRICE: 2, SUBSCRIPTION_PRO_CURRENCY: 'USD', SUBSCRIPTION_PRO_POINTS_PRICE: 999, SUBSCRIPTION_TRIAL_DAYS: 7 })[key]);
    expect(service.getPlans()[0]).toMatchObject({ amount: 5000, currency: 'CDF', durationDays: 30, trialDays: 30, commissionRate: 0.05, pointsAmount: 500, cashCommissionRequiresPurchasedTokens: true });
    expect(walletService.convertMoneyToPoints).toHaveBeenCalledWith(5000, 'CDF');
    const started = new Date('2026-01-31T10:00:00Z');
    expect((service as any).calculateEndDate(started).toISOString()).toBe('2026-03-02T10:00:00.000Z');
  });

  it('lists points as a subscription payment option', () => {
    expect(service.getPlans()).toEqual([
      expect.objectContaining({
        paymentMethods: [
          PaymentMethod.MOBILE_MONEY,
          PaymentMethod.CARD,
          'points',
        ],
        pointsAmount: 500,
        pointsCurrency: 'PTS',
        tokensAmount: 500,
        tokensCurrency: 'PTS',
        subscriptionRewardTokens: 25,
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
        amount: 500,
        currency: 'PTS',
      }),
      500,
      subscriptionRepository.manager,
    );
    expect(subscriptionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SubscriptionStatus.ACTIVE,
        paymentReference: 'POINTS-wallet-entry-1',
        paymentTransactionId: null,
      }),
    );
    expect(result.subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(walletService.awardSubscriptionPaymentTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'subscription-1',
        userId: 'driver-1',
        status: SubscriptionStatus.ACTIVE,
      }),
      undefined,
      subscriptionRepository.manager,
    );
    expect(result.walletEntry?.id).toBe('wallet-entry-1');
    expect(result.payment).toEqual(
      expect.objectContaining({
        status: PaymentStatus.SUCCEEDED,
        reference: 'POINTS-wallet-entry-1',
        amount: 500,
        currency: 'PTS',
      }),
    );
  });

  it('does not pay the referrer when the first Pro month is paid with welcome tokens', async () => {
    await service.subscribeWithPoints('driver-1', { plan: SubscriptionPlan.PRO });
    expect(referralsService.awardSubscriptionReward).not.toHaveBeenCalled();
  });

  it('credits the reward only after FlexPay confirms the subscription payment', async () => {
    const subscription = {
      id: 'subscription-1',
      userId: 'driver-1',
      status: SubscriptionStatus.PENDING,
      startDate: new Date(),
      endDate: new Date(),
      amount: 5000,
      currency: 'CDF',
    };
    const initiatedPayment = {
      id: 'payment-1',
      reference: 'SUB-1',
      status: PaymentStatus.INITIATED,
    };
    await subscriptionRepository.save(subscription);

    await (service as any).applyPaymentToSubscription(
      { ...subscription },
      initiatedPayment,
    );

    expect(walletService.awardSubscriptionPaymentTokens).not.toHaveBeenCalled();

    await (service as any).applyPaymentToSubscription(
      { ...subscription },
      { ...initiatedPayment, status: PaymentStatus.SUCCEEDED },
    );

    expect(walletService.awardSubscriptionPaymentTokens).toHaveBeenCalledTimes(
      1,
    );
    expect(walletService.awardSubscriptionPaymentTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'subscription-1',
        userId: 'driver-1',
        status: SubscriptionStatus.ACTIVE,
      }),
      'payment-1',
    );
  });

  it('does not activate or reward an insufficient points purchase', async () => {
    walletService.payForSubscription.mockRejectedValue(
      new BadRequestException(
        'Solde de jetons insuffisant pour payer cet abonnement',
      ),
    );

    await expect(
      service.subscribeWithPoints('driver-1', {
        plan: SubscriptionPlan.PRO,
      }),
    ).rejects.toThrow('Solde de jetons insuffisant');

    expect(subscriptionRepository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: SubscriptionStatus.ACTIVE,
      }),
    );
    expect(walletService.awardSubscriptionPaymentTokens).not.toHaveBeenCalled();
  });

  it('lists current pro subscriptions without regard to case', async () => {
    const query = {
      leftJoin: jest.fn(),
      addSelect: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([
        [
          {
            id: 'sub-1',
            userId: 'driver-1',
            plan: SubscriptionPlan.PRO,
            status: SubscriptionStatus.ACTIVE,
            startDate: new Date('2026-10-01T00:00:00.000Z'),
            endDate: new Date('2026-10-31T00:00:00.000Z'),
            amount: '5000.00',
            currency: 'CDF',
            isTrial: false,
            user: {
              id: 'driver-1',
              firstName: 'Aline',
              lastName: 'Kabila',
              phone: '+243810000000',
              email: 'aline@example.com',
              password: 'secret',
            },
          },
        ],
        1,
      ]),
    };
    for (const method of [
      'leftJoin',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ] as const) {
      query[method].mockReturnValue(query);
    }
    (subscriptionRepository as { createQueryBuilder?: jest.Mock }).createQueryBuilder =
      jest.fn().mockReturnValue(query);

    const result = await service.listActiveProSubscriptions(1, 25, 'aline');

    expect(query.where).toHaveBeenCalledWith('subscription.plan = :plan', {
      plan: SubscriptionPlan.PRO,
    });
    expect(query.andWhere).toHaveBeenCalledWith('subscription.status = :status', {
      status: SubscriptionStatus.ACTIVE,
    });
    expect(query.andWhere).toHaveBeenCalledWith(
      'subscription.endDate > :now',
      expect.objectContaining({ now: expect.any(Date) }),
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('ILIKE'),
      { proSearch: '%aline%' },
    );
    expect(result).toMatchObject({ total: 1, page: 1, limit: 25 });
    expect(result.subscriptions[0].amount).toBe(5000);
    expect(result.subscriptions[0].user).toEqual({
      id: 'driver-1',
      firstName: 'Aline',
      lastName: 'Kabila',
      phone: '+243810000000',
      email: 'aline@example.com',
    });
  });

  it('limits the list to subscriptions started in the current Kinshasa month', async () => {
    const query = {
      leftJoin: jest.fn(),
      addSelect: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    for (const method of [
      'leftJoin',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ] as const) {
      query[method].mockReturnValue(query);
    }
    (subscriptionRepository as { createQueryBuilder?: jest.Mock }).createQueryBuilder =
      jest.fn().mockReturnValue(query);
    const month = kinshasaCalendarMonth(new Date('2026-10-13T12:00:00.000Z'));

    await service.listActiveProSubscriptions(1, 25, undefined, 'current');

    expect(query.andWhere).toHaveBeenCalledWith(
      'subscription.startDate >= :monthFrom AND subscription.startDate < :monthTo',
      expect.objectContaining({
        monthFrom: month.from,
        monthTo: month.to,
      }),
    );
  });
});
