import {
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { SubscriptionPlan } from '../subscriptions/entities/subscription.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { of, Subject } from 'rxjs';
import { ReferralAccount } from './entities/referral-account.entity';
import {
  ReferralLedgerEntry,
  ReferralLedgerEntryType,
} from './entities/referral-ledger-entry.entity';
import { ReferralProfile } from './entities/referral-profile.entity';
import {
  ReferralReward,
  ReferralRewardSourceType,
  ReferralRewardStatus,
} from './entities/referral-reward.entity';
import { ReferralsService } from './referrals.service';
import { WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';

describe('ReferralsService', () => {
  const buildService = (options?: {
    existingReward?: ReferralReward;
    chottuLink?: boolean;
    referralProfiles?: ReferralProfile[];
    referralEarnings?: {
      referredUserId: string;
      rewardCount: string;
      earnedTokens: string;
      pendingTokens: string;
      releasedTokens: string;
      reversedTokens: string;
    }[];
    bookingPayment?: PaymentTransaction | null;
    configOverrides?: Record<string, string | number | undefined>;
  }) => {
    const account = {
      id: 'account-1',
      userId: 'referrer-1',
      pendingTokens: 0,
      availableTokens: 0,
      reservedTokens: 0,
      withdrawnTokens: 0,
      currency: 'PTS',
    } as ReferralAccount;
    const profile = {
      id: 'profile-referred',
      userId: 'referred-1',
      code: 'ZWREFERRED',
      referredByUserId: 'referrer-1',
      referredAt: new Date('2026-08-01T00:00:00Z'),
      linkToken: 'referred-link-token-abcdefghijklmnopqrstuvwxyz',
      shareLinkUrl: null,
      shareLinkGeneratedAt: null,
      qualifiedAt: null,
      rewardWindowEndsAt: null,
    } as ReferralProfile;
    const matureQuery: any = {};
    for (const key of ['where', 'andWhere', 'orderBy', 'take', 'setLock', 'setOnLocked']) matureQuery[key] = jest.fn().mockReturnValue(matureQuery);
    matureQuery.getMany = jest.fn().mockResolvedValue([]);
    const manager = {
      getRepository: jest.fn(() => ({ createQueryBuilder: () => matureQuery })),
      query: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
      findOne: jest.fn((entity: unknown, findOptions?: unknown) => {
        void findOptions;
        const result =
          entity === ReferralReward
            ? null
            : entity === ReferralProfile
              ? profile
              : entity === ReferralAccount
                ? account
                : entity === ReferralLedgerEntry
                  ? null
                  : {
                      id: 'referrer-1',
                      isActive: true,
                      status: UserStatus.ACTIVE,
                    };
        return Promise.resolve(result);
      }),
      create: jest.fn((_entity: unknown, value: Record<string, unknown>) => ({
        ...value,
      })),
      save: jest.fn((value: Record<string, unknown>) => {
        if ('description' in value && !value.id) value.id = 'ledger-1';
        if ('sourceType' in value && !value.id) value.id = 'reward-1';
        return Promise.resolve(value);
      }),
    };
    const dataSource = {
      getRepository: jest.fn(() => ({ find: jest.fn().mockResolvedValue([{ type: WalletLedgerEntryType.BOOKING_PAYMENT, amount: -1000, currency: 'PTS' }]) })),
      transaction: jest.fn((callback: (value: typeof manager) => unknown) =>
        callback(manager),
      ),
    };
    const rewardStatsQuery = {
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(options?.referralEarnings ?? []),
    };
    const rewardRepository = {
      findOne: jest.fn().mockResolvedValue(options?.existingReward ?? null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue(rewardStatsQuery),
    };
    const profileRepository = {
      findOne: jest.fn(),
      count: jest
        .fn()
        .mockResolvedValue(options?.referralProfiles?.length ?? 0),
      find: jest.fn().mockResolvedValue(options?.referralProfiles ?? []),
      save: jest.fn((value: ReferralProfile) => Promise.resolve(value)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, string | number | undefined> = {
          REFERRAL_REWARD_RATE: 0.01,
          REFERRAL_SUBSCRIPTION_REWARD_RATE: 0.01,
          REFERRAL_BOOKING_REWARD_RATE: 0.01,
          REFERRAL_ATTRIBUTION_BONUS_TOKENS: 5,
          ZWANGA_COMMISSION_RATE: 0.05,
          REFERRAL_HOLD_DAYS: 7,
          REFERRAL_REWARD_WINDOW_MONTHS: 12,
          REFERRAL_MONEY_PER_TOKEN_CDF: 100,
          ...(options?.chottuLink
            ? {
                CHOTTULINK_REST_API_KEY: 'c_api_test',
                CHOTTULINK_DOMAIN: 'zwanga.chottu.link',
                CHOTTULINK_API_URL:
                  'https://api2.chottulink.com/chotuCore/pa/v1/create-link',
              }
            : {}),
          ...options?.configOverrides,
        };
        return values[key];
      }),
    };
    const httpService = {
      post: jest.fn().mockReturnValue(
        of({
          data: { short_url: 'https://zwanga.chottu.link/AbCdEf' },
        }),
      ),
    };
    const notificationService = {
      sendNotification: jest.fn().mockResolvedValue(true),
    };
    const paymentRepository = {
      findOne: jest.fn().mockResolvedValue(options?.bookingPayment ?? null),
    };
    const kycRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    const service = new ReferralsService(
      profileRepository as any,
      {} as any,
      rewardRepository as any,
      {} as any,
      {} as any,
      {} as any,
      kycRepository as any,
      paymentRepository as any,
      dataSource as any,
      configService as any,
      httpService as any,
      {} as any,
      notificationService as any,
    );
    return {
      service,
      account,
      profile,
      profileRepository,
      httpService,
      notificationService,
      paymentRepository,
      kycRepository,
      manager,
      dataSource,
    };
  };

  const paymentPaidAt = new Date('2026-08-24T10:00:00Z');

  it('rejects referral withdrawals below 1000 tokens before releasing rewards or reserving a balance', async () => {
    const { service, account, dataSource, manager, kycRepository } = buildService();
    account.availableTokens = 1000;
    kycRepository.findOne.mockResolvedValue({ status: 'approved' });
    const release = jest.spyOn(service as any, 'releaseMatureRewardsForUser');
    await expect(service.requestWithdrawal('referrer-1', {
      tokens: 50, phone: '+243891234567',
    })).rejects.toMatchObject({ status: 400 });
    expect(release).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(account.availableTokens).toBe(1000);
    expect(account.reservedTokens).toBe(0);
  });

  it('marks referral withdrawals unavailable while preserving the earned token balance', async () => {
    const { service, account, kycRepository } = buildService();
    account.availableTokens = 100;
    kycRepository.findOne.mockResolvedValue({ status: 'approved' });
    const summary = await service.getSummary('referrer-1');
    expect(summary.withdrawal).toMatchObject({
      enabled: true, blocked: true, minimumTokens: 1000, moneyPerToken: 10,
      kycApproved: true,
    });
    expect(summary.balances.availableTokens).toBe(100);
    expect(summary.balances.availableAmount).toBe(1000);
    expect(account.reservedTokens).toBe(0);
  });

  it('uses the supplied batch transaction and keeps both ledger entries without a second credit', async () => {
    const { service, manager, account, dataSource } = buildService();
    const reward = { id: 'mature-reward', referrerUserId: account.userId, rewardTokens: 2.5,
      status: ReferralRewardStatus.PENDING, holdUntil: new Date('2020-01-01'), paymentTransactionId: 'payment' };
    account.pendingTokens = 10;
    account.availableTokens = 4;
    manager.findOne.mockImplementation((entity: unknown) => Promise.resolve(entity === ReferralReward ? reward : account) as any);
    await (service as any).releaseRewardById(reward.id, manager);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(account.pendingTokens).toBe(7.5);
    expect(account.availableTokens).toBe(6.5);
    const ledger = manager.create.mock.calls.filter(call => call[0] === ReferralLedgerEntry).map(call => call[1]);
    expect(ledger).toEqual([
      expect.objectContaining({ type: ReferralLedgerEntryType.REWARD_RELEASED, bucket: 'pending', amountTokens: -2.5, balanceAfter: 7.5 }),
      expect.objectContaining({ type: ReferralLedgerEntryType.REWARD_RELEASED, bucket: 'available', amountTokens: 2.5, balanceAfter: 6.5 }),
    ]);
    expect(reward.status).toBe(ReferralRewardStatus.AVAILABLE);
    await (service as any).releaseRewardById(reward.id, manager);
    expect(account.availableTokens).toBe(6.5);
    expect(manager.create).toHaveBeenCalledTimes(2);
  });
  const succeededSubscriptionPayment = {
    id: 'payment-1',
    userId: 'referred-1',
    purpose: PaymentPurpose.SUBSCRIPTION_PRO,
    provider: PaymentProvider.FLEXPAY,
    status: PaymentStatus.SUCCEEDED,
    amount: 5000,
    currency: 'CDF',
    paidAt: paymentPaidAt,
  } as unknown as PaymentTransaction;

  const succeededBookingPayment = {
    id: 'payment-booking-1',
    userId: 'referred-1',
    purpose: PaymentPurpose.TRIP_BOOKING,
    provider: PaymentProvider.FLEXPAY,
    status: PaymentStatus.SUCCEEDED,
    amount: 10000,
    currency: 'CDF',
    paidAt: paymentPaidAt,
  } as unknown as PaymentTransaction;

  it('credits exactly 1 percent of an eligible subscription payment', async () => {
    const { service, account, profile } = buildService();

    const reward = await service.awardSubscriptionReward(
      {
        id: 'subscription-1',
        userId: 'referred-1',
        plan: SubscriptionPlan.PRO,
        isTrial: false,
      } as any,
      succeededSubscriptionPayment,
    );

    expect(reward).toEqual(
      expect.objectContaining({
        sourceType: ReferralRewardSourceType.SUBSCRIPTION_PAYMENT,
        grossAmount: 5000,
        rewardAmount: 50,
        rewardTokens: 5,
        rate: 0.01,
        status: ReferralRewardStatus.PENDING,
      }),
    );
    expect(account.pendingTokens).toBe(5);
    expect(profile.qualifiedAt).toEqual(paymentPaidAt);
    expect(profile.rewardWindowEndsAt?.toISOString()).toBe(
      '2027-08-24T10:00:00.000Z',
    );
  });

  it.each([
    { label: 'old dedicated rate', dedicated: 0.05, legacy: 0.05 },
    { label: 'old legacy fallback', dedicated: undefined, legacy: 0.05 },
    { label: 'missing configuration', dedicated: undefined, legacy: undefined },
    { label: 'string configuration', dedicated: '0.05', legacy: undefined },
    { label: 'invalid configuration', dedicated: 'invalid', legacy: 0.05 },
    { label: 'negative configuration', dedicated: -1, legacy: undefined },
    { label: 'zero configuration', dedicated: 0, legacy: undefined },
    { label: 'nonfinite configuration', dedicated: Infinity, legacy: undefined },
    { label: 'dedicated rate priority', dedicated: 0.01, legacy: 0.05 },
  ])('uses 1 percent for new subscription rewards and the mobile summary with $label', async ({ dedicated, legacy }) => {
    const { service, account } = buildService({
      configOverrides: {
        REFERRAL_SUBSCRIPTION_REWARD_RATE: dedicated,
        REFERRAL_REWARD_RATE: legacy,
      },
    });
    const reward = await service.awardSubscriptionReward({
      id: 'subscription-rate-policy', userId: 'referred-1', isTrial: false,
    } as any, succeededSubscriptionPayment);
    expect(reward).toMatchObject({ rate: 0.01, rewardAmount: 50, rewardTokens: 5 });
    expect(account.pendingTokens).toBe(5);
    expect((await service.getSummary('referrer-1')).rules).toMatchObject({
      subscriptionRewardRate: 0.01,
      bookingRewardRate: 0.01,
      platformCommissionRate: 0.05,
      attributionBonusTokens: 0,
    });
  });

  it('also credits 1 percent on a confirmed PawaPay subscription', async () => {
    const { service, account } = buildService();
    const reward = await service.awardSubscriptionReward({
      id: 'subscription-pawapay', userId: 'referred-1', isTrial: false,
    } as any, { ...succeededSubscriptionPayment, provider: PaymentProvider.PAWAPAY });
    expect(reward).toMatchObject({ rate: 0.01, rewardAmount: 50, rewardTokens: 5 });
    expect(account.pendingTokens).toBe(5);
  });

  it('keeps a more restrictive configured subscription rate', async () => {
    const { service } = buildService({
      configOverrides: { REFERRAL_SUBSCRIPTION_REWARD_RATE: 0.005 },
    });
    const reward = await service.awardSubscriptionReward({
      id: 'subscription-lower-rate', userId: 'referred-1', isTrial: false,
    } as any, succeededSubscriptionPayment);
    expect(reward).toMatchObject({ rate: 0.005, rewardAmount: 25, rewardTokens: 2.5 });
  });

  it('returns a historical 5 percent reward without recalculation or a second balance mutation', async () => {
    const existingReward = {
      id: 'reward-existing',
      sourceType: ReferralRewardSourceType.SUBSCRIPTION_PAYMENT,
      sourceEntityId: 'subscription-1',
      rate: 0.05,
      rewardAmount: 250,
      rewardTokens: 25,
    } as ReferralReward;
    const { service, dataSource } = buildService({ existingReward });

    const reward = await service.awardSubscriptionReward(
      {
        id: 'subscription-1',
        userId: 'referred-1',
        isTrial: false,
      } as any,
      succeededSubscriptionPayment,
    );

    expect(reward).toBe(existingReward);
    expect(reward).toMatchObject({ rate: 0.05, rewardAmount: 250, rewardTokens: 25 });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { isTrial: true, currency: 'CDF' },
    { isTrial: false, currency: 'PTS', amount: 500 },
    { isTrial: false, currency: 'POINTS', amount: 500 },
    { isTrial: false, currency: 'CDF', paymentReference: 'POINTS-welcome-bonus-debit' },
  ])('does not pay a referrer for free/bonus-funded Pro even with a stray successful provider payment: %j', async markers => {
    const { service, account, dataSource } = buildService();
    const reward = await service.awardSubscriptionReward({
      id: 'subscription-bonus', userId: 'referred-1', ...markers,
    } as any, succeededSubscriptionPayment);
    expect(reward).toBeNull();
    expect(account.pendingTokens).toBe(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not reward an unconfirmed payment', async () => {
    const { service, dataSource } = buildService();

    const reward = await service.awardSubscriptionReward(
      {
        id: 'subscription-1',
        userId: 'referred-1',
        isTrial: false,
      } as any,
      {
        ...succeededSubscriptionPayment,
        status: PaymentStatus.INITIATED,
      },
    );

    expect(reward).toBeNull();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not reward a payment completed before an existing account was attached', async () => {
    const { service, account, profile } = buildService();
    profile.referredAt = new Date('2026-08-25T10:00:00Z');

    const reward = await service.awardSubscriptionReward(
      {
        id: 'subscription-before-attribution',
        userId: 'referred-1',
        plan: SubscriptionPlan.PRO,
        isTrial: false,
      } as any,
      succeededSubscriptionPayment,
    );

    expect(reward).toBeNull();
    expect(account.pendingTokens).toBe(0);
    expect(profile.qualifiedAt).toBeNull();
  });

  it('credits 1 percent of an eligible electronic trip payment from the Zwanga commission', async () => {
    const { service, account } = buildService({
      bookingPayment: succeededBookingPayment,
    });

    const reward = await service.awardBookingReward({
      id: 'booking-electronic-1',
      passengerId: 'referred-1',
      status: BookingStatus.COMPLETED,
      droppedOff: true,
      paymentMode: TripPaymentMode.ELECTRONIC,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentTransactionId: 'payment-booking-1',
      paidAt: paymentPaidAt,
    } as any);

    expect(reward).toEqual(
      expect.objectContaining({
        sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
        grossAmount: 10000,
        rewardAmount: 100,
        rewardTokens: 10,
        rate: 0.01,
        paymentTransactionId: 'payment-booking-1',
        status: ReferralRewardStatus.PENDING,
      }),
    );
    expect(account.pendingTokens).toBe(10);
  });

  it.each([TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS])(
    'rewards the final reduced fare, not the original payment (%s)', async paymentMode => {
      const { service } = buildService({ bookingPayment: succeededBookingPayment });
      const reward = await service.awardBookingReward({
        id: 'adjusted-fare', passengerId: 'referred-1', status: BookingStatus.COMPLETED,
        droppedOff: true, paymentMode, paymentStatus: BookingPaymentStatus.SUCCEEDED,
        paymentTransactionId: succeededBookingPayment.id, paidAt: paymentPaidAt,
        paymentAmount: 8000, paymentCurrency: 'CDF', interruptionFareLocked: true,
      } as any);
      expect(reward).toMatchObject({ grossAmount: 8000, rewardAmount: 80, rewardTokens: 8 });
    },
  );

  it.each([-1, 10001, NaN, null, undefined])('refuses an inconsistent final fare (%s)', async paymentAmount => {
    const { service } = buildService({ bookingPayment: succeededBookingPayment });
    await expect(service.awardBookingReward({
      id: 'invalid-final-fare', passengerId: 'referred-1', status: BookingStatus.COMPLETED,
      droppedOff: true, paymentMode: TripPaymentMode.ELECTRONIC,
      paymentStatus: BookingPaymentStatus.SUCCEEDED, paymentTransactionId: succeededBookingPayment.id,
      paymentAmount, paymentCurrency: 'CDF', interruptionFareLocked: true,
    } as any)).rejects.toThrow('montant final');
  });

  it('does not reward a fully refunded interrupted electronic fare', async () => {
    const { service } = buildService({ bookingPayment: succeededBookingPayment });
    await expect(service.awardBookingReward({
      id: 'zero-final-fare', passengerId: 'referred-1', status: BookingStatus.COMPLETED,
      droppedOff: true, paymentMode: TripPaymentMode.ELECTRONIC,
      paymentStatus: BookingPaymentStatus.SUCCEEDED, paymentTransactionId: succeededBookingPayment.id,
      paymentAmount: 0, paymentCurrency: 'CDF', interruptionFareLocked: true,
    } as any)).resolves.toBeNull();
  });

  it('returns summaries without awaiting short links or settling rewards on the read path', async () => {
    const { service, httpService } = buildService({ chottuLink: true });
    const slow = new Subject<any>();
    httpService.post.mockReturnValue(slow);
    const release = jest.spyOn(service as any, 'releaseMatureRewardsForUser');
    const first = await service.getSummary('referrer-1');
    await service.getSummary('referrer-1');
    expect(JSON.stringify(first)).toContain('referralToken=');
    expect(httpService.post).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    slow.next({ data: { short_url: 'https://zwanga.chottu.link/AbCdEf' } });
    slow.complete();
    await Promise.all((service as any).shareLinkRefreshes.values());
  });

  it('caps trip referral rewards at 1 percent even if the booking rate is misconfigured at 5 percent', async () => {
    const { service, account } = buildService({
      bookingPayment: succeededBookingPayment,
      configOverrides: {
        REFERRAL_BOOKING_REWARD_RATE: 0.05,
      },
    });

    const reward = await service.awardBookingReward({
      id: 'booking-electronic-misconfigured-rate',
      passengerId: 'referred-1',
      status: BookingStatus.COMPLETED,
      droppedOff: true,
      paymentMode: TripPaymentMode.ELECTRONIC,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentTransactionId: 'payment-booking-1',
      paidAt: paymentPaidAt,
    } as any);

    expect(reward).toEqual(
      expect.objectContaining({
        sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
        grossAmount: 10000,
        rewardAmount: 100,
        rewardTokens: 10,
        rate: 0.01,
      }),
    );
    expect(account.pendingTokens).toBe(10);
  });

  it('exposes trip rewards as a 1 percent share funded from the 5 percent Zwanga commission', async () => {
    const { service } = buildService({
      configOverrides: {
        REFERRAL_BOOKING_REWARD_RATE: 0.05,
      },
    });

    await expect(service.getSummary('referrer-1')).resolves.toEqual(
      expect.objectContaining({
        rules: expect.objectContaining({
          rewardRate: 0.01,
          bookingRewardRate: 0.01,
          bookingRewardFunding: 'platform_commission_share',
          platformCommissionRate: 0.05,
          platformRetainedBookingCommissionRate: 0.04,
          attributionBonusTokens: 0,
        }),
      }),
    );
  });

  it('credits 1 percent of an eligible trip paid with Zwanga tokens without requiring FlexPay', async () => {
    const { service, account, paymentRepository } = buildService();

    const reward = await service.awardBookingReward({
      id: 'booking-points-1',
      passengerId: 'referred-1',
      status: BookingStatus.COMPLETED,
      droppedOff: true,
      paymentMode: TripPaymentMode.POINTS,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentAmount: 10000,
      paymentCurrency: 'CDF',
      paymentTransactionId: null,
      paidAt: paymentPaidAt,
    } as any);

    expect(paymentRepository.findOne).not.toHaveBeenCalled();
    expect(reward).toEqual(
      expect.objectContaining({
        sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
        grossAmount: 10000,
        rewardAmount: 100,
        rewardTokens: 10,
        rate: 0.01,
        paymentTransactionId: null,
        status: ReferralRewardStatus.PENDING,
      }),
    );
    expect(account.pendingTokens).toBe(10);
  });

  it.each([
    { status: BookingStatus.ACCEPTED },
    { status: BookingStatus.CANCELLED },
    { droppedOff: false },
    { paymentStatus: BookingPaymentStatus.INITIATED },
    { paymentStatus: BookingPaymentStatus.FAILED },
    { paymentMode: TripPaymentMode.CASH },
  ])('does not reward an unfinished, unpaid or ineligible trip: %j', async patch => {
    const { service, account, dataSource } = buildService();
    await expect(service.awardBookingReward({
      id: 'booking-ineligible', passengerId: 'referred-1',
      status: BookingStatus.COMPLETED, droppedOff: true,
      paymentMode: TripPaymentMode.POINTS, paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentAmount: 10000, paymentCurrency: 'CDF', ...patch,
    } as any)).resolves.toBeNull();
    expect(account.pendingTokens).toBe(0);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('calculates referral rewards for a subsidized first trip on the amount paid by the filleul only', async () => {
    const { service, account } = buildService({
      bookingPayment: {
        ...succeededBookingPayment,
        id: 'payment-booking-subsidized',
        amount: 4000,
      } as PaymentTransaction,
    });

    const reward = await service.awardBookingReward({
      id: 'booking-subsidized-1',
      passengerId: 'referred-1',
      status: BookingStatus.COMPLETED,
      droppedOff: true,
      paymentMode: TripPaymentMode.ELECTRONIC,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentTransactionId: 'payment-booking-subsidized',
      paymentAmount: 4000,
      grossPaymentAmount: 10000,
      firstTripSubsidyApplied: true,
      zwangaSubsidyAmount: 6000,
      paidAt: paymentPaidAt,
    } as any);

    expect(reward).toEqual(
      expect.objectContaining({
        sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
        grossAmount: 4000,
        rewardAmount: 40,
        rewardTokens: 4,
        rate: 0.01,
        paymentTransactionId: 'payment-booking-subsidized',
        status: ReferralRewardStatus.PENDING,
      }),
    );
    expect(account.pendingTokens).toBe(4);
  });

  it.each([{ entries: [] }, { entries: [{ type: WalletLedgerEntryType.BOOKING_PAYMENT, amount: 10, currency: 'PTS' }] }])(
    'does not turn a points success flag without an actual debit into a referral credit', async ({ entries }) => {
      const { service, dataSource } = buildService();
      dataSource.getRepository.mockReturnValue({ find: jest.fn().mockResolvedValue(entries) });
      await expect(service.awardBookingReward({ id: 'unbacked', passengerId: 'referred-1', status: BookingStatus.COMPLETED,
        droppedOff: true, paymentMode: TripPaymentMode.POINTS, paymentStatus: BookingPaymentStatus.SUCCEEDED,
        paymentAmount: 10000, paymentCurrency: 'CDF' } as any)).rejects.toThrow('débit en jetons');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    },
  );

  it('does not reward a fully refunded points payment', async () => {
    const { service, dataSource } = buildService();
    dataSource.getRepository.mockReturnValue({ find: jest.fn().mockResolvedValue([
      { type: WalletLedgerEntryType.BOOKING_PAYMENT, amount: -1000, currency: 'PTS' },
      { type: WalletLedgerEntryType.BOOKING_REFUND, amount: 1000, currency: 'PTS' },
    ]) });
    await expect(service.awardBookingReward({ id: 'refunded', passengerId: 'referred-1', status: BookingStatus.COMPLETED,
      droppedOff: true, paymentMode: TripPaymentMode.POINTS, paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentAmount: 10000, paymentCurrency: 'CDF' } as any)).resolves.toBeNull();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('resolves an active referrer from an opaque link token', async () => {
    const { service, profileRepository } = buildService();
    profileRepository.findOne.mockResolvedValue({
      id: 'profile-referrer',
      userId: 'referrer-1',
      linkToken: 'abcdefghijklmnopqrstuvwxyz123456',
      user: {
        firstName: 'Amina',
        isActive: true,
        status: UserStatus.ACTIVE,
      },
    });

    await expect(
      service.resolveAttribution('abcdefghijklmnopqrstuvwxyz123456'),
    ).resolves.toEqual({
      valid: true,
      referrer: { firstName: 'Amina' },
    });
  });

  it('attaches an existing account without a referrer and remains idempotent', async () => {
    const {
      service,
      account,
      profileRepository,
      manager,
      notificationService,
    } = buildService();
    const referralToken = 'abcdefghijklmnopqrstuvwxyz123456';
    const existingProfile = {
      id: 'profile-existing',
      userId: 'existing-user',
      code: 'ZWEXISTING',
      linkToken: 'existing-user-link-token-123456',
      referredByUserId: null,
      referredAt: null,
      attributionProvider: null,
      attributionLinkToken: null,
      attributionReferringLink: null,
      attributionCapturedAt: null,
      qualifiedAt: null,
      rewardWindowEndsAt: null,
    } as ReferralProfile;
    const referrerProfile = {
      id: 'profile-referrer',
      userId: 'referrer-1',
      linkToken: referralToken,
      user: {
        firstName: 'Amina',
        fcmToken: 'fcm-referrer-1',
        isActive: true,
        status: UserStatus.ACTIVE,
      },
    } as ReferralProfile;

    profileRepository.findOne.mockResolvedValue(referrerProfile);
    manager.findOne.mockImplementation(
      (entity: unknown, findOptions?: { where?: Record<string, string> }) => {
        if (entity === ReferralProfile) {
          if (findOptions?.where?.userId === 'existing-user') {
            return Promise.resolve(existingProfile);
          }
          if (findOptions?.where?.linkToken === referralToken) {
            return Promise.resolve(referrerProfile);
          }
        }
        if (entity === ReferralLedgerEntry) {
          return Promise.resolve(null);
        }
        if (entity === User) {
          if (findOptions?.where?.id === 'referrer-1') {
            return Promise.resolve(referrerProfile.user);
          }
          return Promise.resolve({
            id: 'existing-user',
            firstName: 'Patrick',
            isActive: true,
            status: UserStatus.ACTIVE,
          });
        }
        if (entity === ReferralAccount) return Promise.resolve(account);
        return Promise.resolve({
          id: 'existing-user',
          firstName: 'Patrick',
          isActive: true,
          status: UserStatus.ACTIVE,
        });
      },
    );

    const attribution = {
      referralProvider: 'chottulink' as const,
      referralToken,
      referralReferringLink: 'https://zwanga-app.chottu.link/test',
      referralCapturedAt: new Date().toISOString(),
    };

    await expect(
      service.attachAuthenticatedUser('existing-user', attribution),
    ).resolves.toEqual(
      expect.objectContaining({
        attached: true,
        newlyAttached: true,
        referrer: { firstName: 'Amina' },
      }),
    );
    expect(existingProfile.referredByUserId).toBe('referrer-1');
    expect(existingProfile.attributionProvider).toBe('chottulink');
    expect(account.availableTokens).toBe(0);
    expect(manager.create.mock.calls.some(([entity]) => entity === ReferralLedgerEntry)).toBe(false);
    expect(notificationService.sendNotification).toHaveBeenCalledWith(
      'fcm-referrer-1',
      'Nouveau filleul Zwanga',
      expect.stringContaining('paiements éligibles'),
      expect.objectContaining({ attributionBonusTokens: 0 }),
      'referrer-1',
    );
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['zwanga:referral-user:existing-user'],
    );

    const lockedRelationLookup = manager.findOne.mock.calls.find(
      ([entity, findOptions]) =>
        entity === ReferralProfile &&
        Boolean((findOptions as { relations?: string[] })?.relations) &&
        Boolean((findOptions as { lock?: unknown })?.lock),
    );
    expect(lockedRelationLookup).toBeUndefined();

    await expect(
      service.attachAuthenticatedUser('existing-user', attribution),
    ).resolves.toEqual(
      expect.objectContaining({ attached: true, newlyAttached: false }),
    );
    expect(account.availableTokens).toBe(0);
    expect(notificationService.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('never replaces the referrer of an existing account', async () => {
    const {
      service,
      account,
      profileRepository,
      manager,
      notificationService,
    } = buildService();
    const referralToken = 'abcdefghijklmnopqrstuvwxyz123456';
    const existingProfile = {
      id: 'profile-existing',
      userId: 'existing-user',
      code: 'ZWEXISTING',
      linkToken: 'existing-user-link-token-123456',
      referredByUserId: 'first-referrer',
      referredAt: new Date('2026-08-20T10:00:00.000Z'),
      attributionProvider: 'chottulink',
      attributionLinkToken: 'first-referrer-link-token-123456',
      attributionReferringLink: null,
      attributionCapturedAt: new Date('2026-08-20T09:59:00.000Z'),
      qualifiedAt: null,
      rewardWindowEndsAt: null,
    } as ReferralProfile;
    const secondReferrerProfile = {
      id: 'profile-second-referrer',
      userId: 'second-referrer',
      linkToken: referralToken,
      user: {
        firstName: 'Amina',
        fcmToken: 'fcm-second-referrer',
        isActive: true,
        status: UserStatus.ACTIVE,
      },
    } as ReferralProfile;

    profileRepository.findOne.mockResolvedValue(secondReferrerProfile);
    manager.findOne.mockImplementation(
      (entity: unknown, findOptions?: { where?: Record<string, string> }) => {
        if (entity === ReferralProfile) {
          if (findOptions?.where?.userId === 'existing-user') {
            return Promise.resolve(existingProfile);
          }
          if (findOptions?.where?.linkToken === referralToken) {
            return Promise.resolve(secondReferrerProfile);
          }
        }
        if (entity === User) {
          if (findOptions?.where?.id === 'second-referrer') {
            return Promise.resolve(secondReferrerProfile.user);
          }
          return Promise.resolve({
            id: 'existing-user',
            firstName: 'Patrick',
            isActive: true,
            status: UserStatus.ACTIVE,
          });
        }
        if (entity === ReferralAccount) return Promise.resolve(account);
        return Promise.resolve({
          id: 'existing-user',
          firstName: 'Patrick',
          isActive: true,
          status: UserStatus.ACTIVE,
        });
      },
    );

    await expect(
      service.attachAuthenticatedUser('existing-user', {
        referralProvider: 'chottulink',
        referralToken,
        referralCapturedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('ne peut pas être modifié');
    expect(existingProfile.referredByUserId).toBe('first-referrer');
    expect(notificationService.sendNotification).not.toHaveBeenCalled();
  });

  it('rejects self-referral for an existing account', async () => {
    const {
      service,
      account,
      profileRepository,
      manager,
      notificationService,
    } = buildService();
    const referralToken = 'abcdefghijklmnopqrstuvwxyz123456';
    const existingProfile = {
      id: 'profile-existing',
      userId: 'existing-user',
      code: 'ZWEXISTING',
      linkToken: referralToken,
      referredByUserId: null,
      referredAt: null,
      attributionProvider: null,
      attributionLinkToken: null,
      attributionReferringLink: null,
      attributionCapturedAt: null,
      qualifiedAt: null,
      rewardWindowEndsAt: null,
    } as ReferralProfile;
    const selfProfile = {
      ...existingProfile,
      user: {
        firstName: 'Patrick',
        fcmToken: 'fcm-existing-user',
        isActive: true,
        status: UserStatus.ACTIVE,
      },
    } as ReferralProfile;

    profileRepository.findOne.mockResolvedValue(selfProfile);
    manager.findOne.mockImplementation(
      (entity: unknown, findOptions?: { where?: Record<string, string> }) => {
        if (entity === ReferralProfile) {
          if (findOptions?.where?.userId === 'existing-user') {
            return Promise.resolve(existingProfile);
          }
          if (findOptions?.where?.linkToken === referralToken) {
            return Promise.resolve(selfProfile);
          }
        }
        if (entity === User) {
          return Promise.resolve(selfProfile.user);
        }
        if (entity === ReferralAccount) return Promise.resolve(account);
        return Promise.resolve({
          id: 'existing-user',
          firstName: 'Patrick',
          isActive: true,
          status: UserStatus.ACTIVE,
        });
      },
    );

    await expect(
      service.attachAuthenticatedUser('existing-user', {
        referralProvider: 'chottulink',
        referralToken,
        referralCapturedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('propre code de parrainage');
    expect(existingProfile.referredByUserId).toBeNull();
    expect(notificationService.sendNotification).not.toHaveBeenCalled();
  });

  it('rejects a ChottuLink attribution captured outside the 30-day window', async () => {
    const { service, profileRepository } = buildService();

    await expect(
      service.assertReferralAttribution({
        referralToken: 'abcdefghijklmnopqrstuvwxyz123456',
        referralCapturedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('expiré après 30 jours');
    expect(profileRepository.findOne).not.toHaveBeenCalled();
  });

  it('creates a ChottuLink server-side without exposing the REST key in the body', async () => {
    const { service, httpService, profileRepository } = buildService({
      chottuLink: true,
    });
    const profile = {
      id: 'profile-referrer',
      code: 'ZWREFERRER',
      linkToken: 'abcdefghijklmnopqrstuvwxyz123456',
      shareLinkUrl: null,
      shareLinkGeneratedAt: null,
    } as ReferralProfile;
    const chottuLinkTestApi = service as unknown as {
      getOrCreateChottuLinkShareLink: (
        value: ReferralProfile,
      ) => Promise<string>;
    };

    await expect(
      chottuLinkTestApi.getOrCreateChottuLinkShareLink(profile),
    ).resolves.toBe('https://zwanga.chottu.link/AbCdEf');

    expect(httpService.post).toHaveBeenCalledWith(
      'https://api2.chottulink.com/chotuCore/pa/v1/create-link',
      {
        domain: 'zwanga.chottu.link',
        destination_url:
          'https://zwanga.app/register?provider=chottulink&referralToken=abcdefghijklmnopqrstuvwxyz123456',
        link_name: 'Parrainage Zwanga ZWREFERRER',
        ios_behavior: 2,
        android_behavior: 2,
        utm_source: 'user_share',
        utm_medium: 'referral',
        utm_campaign: 'zwanga_referral',
        social_title: 'Rejoignez-moi sur Zwanga',
        social_description:
          "Installez Zwanga avec mon lien d'invitation personnel.",
      },
      {
        headers: {
          'API-KEY': 'c_api_test',
          'Content-Type': 'application/json',
        },
      },
    );
    expect(profileRepository.update).toHaveBeenCalledWith(
      profile.id,
      expect.objectContaining({
        shareLinkUrl: 'https://zwanga.chottu.link/AbCdEf',
      }),
    );
  });

  it('shows each referral with only the non-reversed earnings they generated', async () => {
    const referredProfile = {
      userId: 'referred-1',
      referredAt: new Date('2026-08-01T00:00:00Z'),
      qualifiedAt: new Date('2026-08-10T00:00:00Z'),
      rewardWindowEndsAt: new Date('2027-08-10T00:00:00Z'),
      user: { firstName: 'Amina', lastName: 'Kalala' },
    } as ReferralProfile;
    const { service } = buildService({
      referralProfiles: [referredProfile],
      referralEarnings: [
        {
          referredUserId: 'referred-1',
          rewardCount: '3',
          earnedTokens: '5.5',
          pendingTokens: '1.5',
          releasedTokens: '4',
          reversedTokens: '2',
        },
      ],
    });

    await expect(service.getReferrals('referrer-1')).resolves.toEqual([
      expect.objectContaining({
        userId: 'referred-1',
        firstName: 'Amina',
        lastNameInitial: 'K.',
        earnings: {
          rewardCount: 3,
          earnedTokens: 5.5,
          pendingTokens: 1.5,
          releasedTokens: 4,
          reversedTokens: 2,
          earnedAmount: 55,
          currency: 'CDF',
        },
      }),
    ]);
  });
});
