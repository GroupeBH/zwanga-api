import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import { ReferralRewardStatus } from '../referrals/entities/referral-reward.entity';
import { ReferralWithdrawalStatus } from '../referrals/entities/referral-withdrawal.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { AdminReferralsService } from './admin-referrals.service';

function createQueryBuilderMock() {
  const query = {
    leftJoinAndMapOne: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    select: jest.fn(),
    groupBy: jest.fn(),
    getManyAndCount: jest.fn(),
    getRawMany: jest.fn(),
    getRawOne: jest.fn(),
    getCount: jest.fn(),
  };
  for (const method of [
    'leftJoinAndMapOne',
    'addSelect',
    'where',
    'andWhere',
    'orWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'select',
    'groupBy',
  ] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

describe('AdminReferralsService', () => {
  const userRepository = { findOne: jest.fn() };
  const accountRepository = { createQueryBuilder: jest.fn() };
  const profileRepository = { createQueryBuilder: jest.fn() };
  const rewardRepository = { createQueryBuilder: jest.fn() };
  const withdrawalRepository = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
  };
  const referralsService = { checkWithdrawalStatus: jest.fn() };
  let service: AdminReferralsService;

  const safeUser = {
    id: 'user-1',
    firstName: 'Aline',
    lastName: 'Mbuyi',
    phone: '+243810000000',
    email: 'aline@example.com',
    role: UserRole.PASSENGER,
    status: UserStatus.ACTIVE,
    isDriver: false,
    isActive: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminReferralsService(
      userRepository as any,
      accountRepository as any,
      profileRepository as any,
      rewardRepository as any,
      withdrawalRepository as any,
      referralsService as any,
    );
  });

  it('returns accounts, direct referral counts and global balances without private link tokens', async () => {
    const accountsQuery = createQueryBuilderMock();
    const accountSummaryQuery = createQueryBuilderMock();
    const referralCountsQuery = createQueryBuilderMock();
    const referredUsersQuery = createQueryBuilderMock();
    const pendingWithdrawalsQuery = createQueryBuilderMock();

    accountsQuery.getManyAndCount.mockResolvedValue([
      [
        {
          id: 'account-1',
          userId: 'user-1',
          user: { ...safeUser, password: 'must-not-leak' },
          profile: {
            code: 'ZWALINE',
            shareLinkUrl: 'https://zwanga.chottu.link/abc',
            referredByUserId: null,
            attributionProvider: 'chottulink',
            qualifiedAt: null,
            rewardWindowEndsAt: null,
            linkToken: 'must-not-leak',
            attributionLinkToken: 'must-not-leak',
          },
          pendingTokens: '10.00',
          availableTokens: '25.50',
          reservedTokens: '5.00',
          withdrawnTokens: '100.00',
          currency: 'PTS',
        },
      ],
      1,
    ]);
    referralCountsQuery.getRawMany.mockResolvedValue([
      { referrerUserId: 'user-1', directReferralsCount: '3' },
    ]);
    accountSummaryQuery.getRawOne.mockResolvedValue({
      accounts: '4',
      pendingTokens: '12.00',
      availableTokens: '50.50',
      reservedTokens: '6.00',
      withdrawnTokens: '125.00',
    });
    referredUsersQuery.getCount.mockResolvedValue(7);
    pendingWithdrawalsQuery.getCount.mockResolvedValue(2);
    accountRepository.createQueryBuilder
      .mockReturnValueOnce(accountsQuery)
      .mockReturnValueOnce(accountSummaryQuery);
    profileRepository.createQueryBuilder
      .mockReturnValueOnce(referralCountsQuery)
      .mockReturnValueOnce(referredUsersQuery);
    withdrawalRepository.createQueryBuilder.mockReturnValue(
      pendingWithdrawalsQuery,
    );

    const result = await service.getAccounts(1, 25);

    expect(result.accounts[0]).toEqual(
      expect.objectContaining({
        directReferralsCount: 3,
        pendingTokens: 10,
        availableTokens: 25.5,
      }),
    );
    expect(result.accounts[0].profile).not.toHaveProperty('linkToken');
    expect(result.accounts[0].profile).not.toHaveProperty(
      'attributionLinkToken',
    );
    expect(result.accounts[0].user).not.toHaveProperty('password');
    expect(result.summary).toEqual({
      accounts: 4,
      referredUsers: 7,
      pendingTokens: 12,
      availableTokens: 50.5,
      reservedTokens: 6,
      withdrawnTokens: 125,
      pendingWithdrawals: 2,
      currency: 'PTS',
    });
  });

  it('returns numeric rewards, applies the status filter and rejects an invalid status', async () => {
    const rewardsQuery = createQueryBuilderMock();
    rewardsQuery.getManyAndCount.mockResolvedValue([
      [
        {
          id: 'reward-1',
          referrerUserId: 'user-1',
          referrerUser: safeUser,
          referredUserId: 'user-2',
          referredUser: { ...safeUser, id: 'user-2' },
          sourceType: 'booking_payment',
          sourceEntityId: '00000000-0000-0000-0000-000000000010',
          paymentTransactionId: '00000000-0000-0000-0000-000000000020',
          grossAmount: '5000.00',
          sourceCurrency: 'CDF',
          rate: '0.050000',
          rewardAmount: '250.00',
          rewardTokens: '2.50',
          sourceMoneyPerToken: '100.0000',
          status: ReferralRewardStatus.AVAILABLE,
          holdUntil: new Date(),
          availableAt: new Date(),
          reversedAt: null,
          reversalReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      1,
    ]);
    rewardRepository.createQueryBuilder.mockReturnValue(rewardsQuery);

    const result = await service.getRewards(
      1,
      25,
      undefined,
      ReferralRewardStatus.AVAILABLE,
    );

    expect(result.rewards[0]).toEqual(
      expect.objectContaining({
        grossAmount: 5000,
        rate: 0.05,
        rewardAmount: 250,
        rewardTokens: 2.5,
      }),
    );
    expect(rewardsQuery.andWhere).toHaveBeenCalledWith(
      'reward.status = :status',
      { status: ReferralRewardStatus.AVAILABLE },
    );
    await expect(
      service.getRewards(1, 25, undefined, 'unknown'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reconciles a withdrawal through the existing idempotent referral flow', async () => {
    const paymentTransaction = {
      id: 'payment-1',
      userId: 'user-1',
      purpose: PaymentPurpose.REFERRAL_PAYOUT,
      relatedEntityType: 'referral_withdrawal',
      relatedEntityId: 'withdrawal-1',
      provider: PaymentProvider.FLEXPAY,
      method: PaymentMethod.MOBILE_MONEY,
      status: PaymentStatus.INITIATED,
      reference: 'REF-1',
      orderNumber: 'ORDER-1',
      providerReference: null,
      providerStatusCode: null,
      providerMessage: null,
      amount: '5000.00',
      currency: 'CDF',
      description: null,
      phone: '+243810000000',
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      rawCheckResponse: { secret: 'must-not-leak' },
    };
    const withdrawal = {
      id: 'withdrawal-1',
      userId: 'user-1',
      user: safeUser,
      tokens: '50.00',
      amount: '5000.00',
      currency: 'CDF',
      moneyPerToken: '100.0000',
      phone: '+243810000000',
      status: ReferralWithdrawalStatus.INITIATED,
      paymentTransactionId: 'payment-1',
      paymentTransaction,
      requestedAt: new Date(),
      processedAt: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    userRepository.findOne.mockResolvedValue({
      id: 'admin-1',
      role: UserRole.ADMIN,
    });
    withdrawalRepository.findOne
      .mockResolvedValueOnce(withdrawal)
      .mockResolvedValueOnce({
        ...withdrawal,
        status: ReferralWithdrawalStatus.SUCCEEDED,
        processedAt: new Date(),
        paymentTransaction: {
          ...paymentTransaction,
          status: PaymentStatus.SUCCEEDED,
        },
      });

    const result = await service.reconcileWithdrawal('admin-1', 'withdrawal-1');

    expect(referralsService.checkWithdrawalStatus).toHaveBeenCalledWith(
      'user-1',
      'ORDER-1',
    );
    expect(result.status).toBe(ReferralWithdrawalStatus.SUCCEEDED);
    expect(result.paymentTransaction).not.toHaveProperty('rawCheckResponse');
  });

  it('forbids withdrawal reconciliation for a non-admin user', async () => {
    userRepository.findOne.mockResolvedValue({
      id: 'user-1',
      role: UserRole.PASSENGER,
    });

    await expect(
      service.reconcileWithdrawal('user-1', 'withdrawal-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(referralsService.checkWithdrawalStatus).not.toHaveBeenCalled();
  });
});
