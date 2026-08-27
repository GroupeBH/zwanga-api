import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { SubscriptionPlan } from '../subscriptions/entities/subscription.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { of } from 'rxjs';
import { ReferralAccount } from './entities/referral-account.entity';
import { ReferralProfile } from './entities/referral-profile.entity';
import {
  ReferralReward,
  ReferralRewardSourceType,
  ReferralRewardStatus,
} from './entities/referral-reward.entity';
import { ReferralsService } from './referrals.service';

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
      qualifiedAt: null,
      rewardWindowEndsAt: null,
    } as ReferralProfile;
    const manager = {
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
        if ('sourceType' in value && !value.id) value.id = 'reward-1';
        if ('description' in value && !value.id) value.id = 'ledger-1';
        return Promise.resolve(value);
      }),
    };
    const dataSource = {
      transaction: jest.fn((callback: (value: typeof manager) => unknown) =>
        callback(manager),
      ),
    };
    const rewardStatsQuery = {
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
      createQueryBuilder: jest.fn().mockReturnValue(rewardStatsQuery),
    };
    const profileRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue(options?.referralProfiles ?? []),
      save: jest.fn((value: ReferralProfile) => Promise.resolve(value)),
    };
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, string | number> = {
          REFERRAL_REWARD_RATE: 0.05,
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

    const service = new ReferralsService(
      profileRepository as any,
      {} as any,
      rewardRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
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
      manager,
      dataSource,
    };
  };

  const paymentPaidAt = new Date('2026-08-24T10:00:00Z');
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

  it('credits exactly 5 percent of an eligible subscription payment', async () => {
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
        rewardAmount: 250,
        rewardTokens: 2.5,
        rate: 0.05,
        status: ReferralRewardStatus.PENDING,
      }),
    );
    expect(account.pendingTokens).toBe(2.5);
    expect(profile.qualifiedAt).toEqual(paymentPaidAt);
    expect(profile.rewardWindowEndsAt?.toISOString()).toBe(
      '2027-08-24T10:00:00.000Z',
    );
  });

  it('returns the existing reward without a second balance mutation', async () => {
    const existingReward = {
      id: 'reward-existing',
      sourceType: ReferralRewardSourceType.SUBSCRIPTION_PAYMENT,
      sourceEntityId: 'subscription-1',
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
    expect(notificationService.sendNotification).toHaveBeenCalledTimes(1);
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
    ).rejects.toThrow('ne peut pas etre modifie');
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
    ).rejects.toThrow('expire apres 30 jours');
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
    expect(profileRepository.save).toHaveBeenCalledWith(
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
          earnedAmount: 550,
          currency: 'CDF',
        },
      }),
    ]);
  });
});
