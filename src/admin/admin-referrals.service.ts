import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, SelectQueryBuilder } from 'typeorm';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { ReferralsService } from '../referrals/referrals.service';
import { ReferralAccount } from '../referrals/entities/referral-account.entity';
import { ReferralProfile } from '../referrals/entities/referral-profile.entity';
import {
  ReferralReward,
  ReferralRewardStatus,
} from '../referrals/entities/referral-reward.entity';
import {
  ReferralWithdrawal,
  ReferralWithdrawalStatus,
} from '../referrals/entities/referral-withdrawal.entity';
import { User, UserRole } from '../users/entities/user.entity';

type AdminReferralAccount = ReferralAccount & {
  user?: User | null;
  profile?: ReferralProfile | null;
};

@Injectable()
export class AdminReferralsService {
  private readonly maxPageLimit = 200;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(ReferralAccount)
    private readonly accountRepository: Repository<ReferralAccount>,
    @InjectRepository(ReferralProfile)
    private readonly profileRepository: Repository<ReferralProfile>,
    @InjectRepository(ReferralReward)
    private readonly rewardRepository: Repository<ReferralReward>,
    @InjectRepository(ReferralWithdrawal)
    private readonly withdrawalRepository: Repository<ReferralWithdrawal>,
    private readonly referralsService: ReferralsService,
  ) {}

  async getAccounts(page: number = 1, limit: number = 25, search?: string) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const query = this.accountRepository
      .createQueryBuilder('account')
      .leftJoinAndMapOne(
        'account.user',
        User,
        'referrerUser',
        'referrerUser.id = account.userId',
      )
      .addSelect(this.userSelect('referrerUser'))
      .leftJoinAndMapOne(
        'account.profile',
        ReferralProfile,
        'profile',
        'profile.userId = account.userId',
      )
      .addSelect([
        'profile.id',
        'profile.userId',
        'profile.code',
        'profile.shareLinkUrl',
        'profile.referredByUserId',
        'profile.attributionProvider',
        'profile.qualifiedAt',
        'profile.rewardWindowEndsAt',
      ]);

    this.applySearch(query, search, [
      'account.userId',
      'referrerUser.firstName',
      'referrerUser.lastName',
      'referrerUser.phone',
      'referrerUser.email',
      'profile.code',
    ]);

    const [accounts, total] = await query
      .orderBy('account.updatedAt', 'DESC')
      .addOrderBy('account.id', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    const referrerIds = accounts.map((account) => account.userId);
    const referralCounts = new Map<string, number>();
    if (referrerIds.length > 0) {
      const countRows = await this.profileRepository
        .createQueryBuilder('profile')
        .select('profile.referredByUserId', 'referrerUserId')
        .addSelect('COUNT(profile.id)', 'directReferralsCount')
        .where('profile.referredByUserId IN (:...referrerIds)', {
          referrerIds,
        })
        .groupBy('profile.referredByUserId')
        .getRawMany<{
          referrerUserId: string;
          directReferralsCount: string;
        }>();
      for (const row of countRows) {
        referralCounts.set(
          row.referrerUserId,
          Number(row.directReferralsCount),
        );
      }
    }

    const [accountSummary, referredUsers, pendingWithdrawals] =
      await Promise.all([
        this.accountRepository
          .createQueryBuilder('account')
          .select('COUNT(account.id)', 'accounts')
          .addSelect('COALESCE(SUM(account.pendingTokens), 0)', 'pendingTokens')
          .addSelect(
            'COALESCE(SUM(account.availableTokens), 0)',
            'availableTokens',
          )
          .addSelect(
            'COALESCE(SUM(account.reservedTokens), 0)',
            'reservedTokens',
          )
          .addSelect(
            'COALESCE(SUM(account.withdrawnTokens), 0)',
            'withdrawnTokens',
          )
          .getRawOne<{
            accounts: string;
            pendingTokens: string;
            availableTokens: string;
            reservedTokens: string;
            withdrawnTokens: string;
          }>(),
        this.profileRepository
          .createQueryBuilder('profile')
          .where('profile.referredByUserId IS NOT NULL')
          .getCount(),
        this.withdrawalRepository
          .createQueryBuilder('withdrawal')
          .where('withdrawal.status IN (:...pendingStatuses)', {
            pendingStatuses: [
              ReferralWithdrawalStatus.PENDING,
              ReferralWithdrawalStatus.INITIATED,
            ],
          })
          .getCount(),
      ]);

    return {
      accounts: (accounts as AdminReferralAccount[]).map((account) => ({
        ...this.serializeAccount(account),
        directReferralsCount: referralCounts.get(account.userId) ?? 0,
      })),
      total,
      page: pageNumber,
      limit: pageSize,
      summary: {
        accounts: Number(accountSummary?.accounts ?? 0),
        referredUsers,
        pendingTokens: Number(accountSummary?.pendingTokens ?? 0),
        availableTokens: Number(accountSummary?.availableTokens ?? 0),
        reservedTokens: Number(accountSummary?.reservedTokens ?? 0),
        withdrawnTokens: Number(accountSummary?.withdrawnTokens ?? 0),
        pendingWithdrawals,
        currency: 'PTS',
      },
    };
  }

  async getRewards(
    page: number = 1,
    limit: number = 25,
    search?: string,
    requestedStatus?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const status = this.normalizeRewardStatus(requestedStatus);
    const query = this.rewardRepository
      .createQueryBuilder('reward')
      .leftJoinAndMapOne(
        'reward.referrerUser',
        User,
        'referrerUser',
        'referrerUser.id = reward.referrerUserId',
      )
      .addSelect(this.userSelect('referrerUser'))
      .leftJoinAndMapOne(
        'reward.referredUser',
        User,
        'referredUser',
        'referredUser.id = reward.referredUserId',
      )
      .addSelect(this.userSelect('referredUser'));

    if (status) {
      query.andWhere('reward.status = :status', { status });
    }
    this.applySearch(query, search, [
      'reward.referrerUserId',
      'reward.referredUserId',
      'reward.sourceEntityId',
      'reward.paymentTransactionId',
      'referrerUser.firstName',
      'referrerUser.lastName',
      'referrerUser.phone',
      'referredUser.firstName',
      'referredUser.lastName',
      'referredUser.phone',
    ]);

    const [rewards, total] = await query
      .orderBy('reward.createdAt', 'DESC')
      .addOrderBy('reward.id', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      rewards: rewards.map((reward) => this.serializeReward(reward)),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async getWithdrawals(
    page: number = 1,
    limit: number = 25,
    search?: string,
    requestedStatus?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const status = this.normalizeWithdrawalStatus(requestedStatus);
    const query = this.withdrawalRepository
      .createQueryBuilder('withdrawal')
      .leftJoinAndMapOne(
        'withdrawal.user',
        User,
        'withdrawalUser',
        'withdrawalUser.id = withdrawal.userId',
      )
      .addSelect(this.userSelect('withdrawalUser'));

    if (status) {
      query.andWhere('withdrawal.status = :status', { status });
    }
    this.applySearch(query, search, [
      'withdrawal.userId',
      'withdrawal.id',
      'withdrawal.paymentTransactionId',
      'withdrawal.phone',
      'withdrawalUser.firstName',
      'withdrawalUser.lastName',
      'withdrawalUser.phone',
      'withdrawalUser.email',
    ]);

    const [withdrawals, total] = await query
      .orderBy('withdrawal.requestedAt', 'DESC')
      .addOrderBy('withdrawal.id', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      withdrawals: withdrawals.map((withdrawal) =>
        this.serializeWithdrawal(withdrawal),
      ),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async reconcileWithdrawal(adminId: string, withdrawalId: string) {
    await this.ensureAdmin(adminId);
    const withdrawal = await this.withdrawalRepository.findOne({
      where: { id: withdrawalId },
      relations: ['user', 'paymentTransaction'],
    });
    if (!withdrawal) {
      throw new NotFoundException('Retrait de parrainage introuvable');
    }
    if (withdrawal.status === ReferralWithdrawalStatus.SUCCEEDED) {
      return this.serializeWithdrawal(withdrawal);
    }

    const orderNumber = withdrawal.paymentTransaction?.orderNumber;
    if (!orderNumber) {
      throw new BadRequestException(
        "Ce retrait n'a pas de transaction FlexPay verifiable",
      );
    }

    await this.referralsService.checkWithdrawalStatus(
      withdrawal.userId,
      orderNumber,
    );
    const reconciled = await this.withdrawalRepository.findOne({
      where: { id: withdrawalId },
      relations: ['user', 'paymentTransaction'],
    });
    if (!reconciled) {
      throw new NotFoundException('Retrait de parrainage introuvable');
    }
    return this.serializeWithdrawal(reconciled);
  }

  private normalizePagination(page: number, limit: number) {
    const pageNumber = Math.max(Number(page) || 1, 1);
    const pageSize = Math.min(
      Math.max(Number(limit) || 25, 1),
      this.maxPageLimit,
    );
    return { pageNumber, pageSize };
  }

  private normalizeRewardStatus(
    requestedStatus?: string,
  ): ReferralRewardStatus | undefined {
    if (!requestedStatus || requestedStatus === 'all') {
      return undefined;
    }
    if (
      !Object.values(ReferralRewardStatus).includes(
        requestedStatus as ReferralRewardStatus,
      )
    ) {
      throw new BadRequestException('Statut de commission invalide');
    }
    return requestedStatus as ReferralRewardStatus;
  }

  private normalizeWithdrawalStatus(
    requestedStatus?: string,
  ): ReferralWithdrawalStatus | undefined {
    if (!requestedStatus || requestedStatus === 'all') {
      return undefined;
    }
    if (
      !Object.values(ReferralWithdrawalStatus).includes(
        requestedStatus as ReferralWithdrawalStatus,
      )
    ) {
      throw new BadRequestException('Statut de retrait invalide');
    }
    return requestedStatus as ReferralWithdrawalStatus;
  }

  private applySearch<T extends object>(
    query: SelectQueryBuilder<T>,
    search: string | undefined,
    columns: string[],
  ): void {
    const term = search?.trim().slice(0, 160);
    if (!term) {
      return;
    }
    query.andWhere(
      new Brackets((builder) => {
        columns.forEach((column, index) => {
          const expression = `CAST(${column} AS TEXT) ILIKE :referralSearch`;
          if (index === 0) {
            builder.where(expression);
          } else {
            builder.orWhere(expression);
          }
        });
      }),
      { referralSearch: `%${term}%` },
    );
  }

  private userSelect(alias: string): string[] {
    return [
      `${alias}.id`,
      `${alias}.firstName`,
      `${alias}.lastName`,
      `${alias}.phone`,
      `${alias}.email`,
      `${alias}.role`,
      `${alias}.status`,
      `${alias}.isDriver`,
      `${alias}.isActive`,
    ];
  }

  private serializeAccount(account: AdminReferralAccount) {
    const profile = account.profile;
    return {
      id: account.id,
      userId: account.userId,
      user: this.serializeUser(account.user),
      profile: profile
        ? {
            code: profile.code,
            shareLinkUrl: profile.shareLinkUrl,
            referredByUserId: profile.referredByUserId,
            attributionProvider: profile.attributionProvider,
            qualifiedAt: profile.qualifiedAt,
            rewardWindowEndsAt: profile.rewardWindowEndsAt,
          }
        : null,
      pendingTokens: Number(account.pendingTokens),
      availableTokens: Number(account.availableTokens),
      reservedTokens: Number(account.reservedTokens),
      withdrawnTokens: Number(account.withdrawnTokens),
      currency: account.currency,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  private serializeReward(reward: ReferralReward) {
    return {
      id: reward.id,
      referrerUserId: reward.referrerUserId,
      referrerUser: this.serializeUser(reward.referrerUser),
      referredUserId: reward.referredUserId,
      referredUser: this.serializeUser(reward.referredUser),
      sourceType: reward.sourceType,
      sourceEntityId: reward.sourceEntityId,
      paymentTransactionId: reward.paymentTransactionId,
      grossAmount: Number(reward.grossAmount),
      sourceCurrency: reward.sourceCurrency,
      rate: Number(reward.rate),
      rewardAmount: Number(reward.rewardAmount),
      rewardTokens: Number(reward.rewardTokens),
      sourceMoneyPerToken: Number(reward.sourceMoneyPerToken),
      status: reward.status,
      holdUntil: reward.holdUntil,
      availableAt: reward.availableAt,
      reversedAt: reward.reversedAt,
      reversalReason: reward.reversalReason,
      createdAt: reward.createdAt,
      updatedAt: reward.updatedAt,
    };
  }

  private serializeWithdrawal(withdrawal: ReferralWithdrawal) {
    return {
      id: withdrawal.id,
      userId: withdrawal.userId,
      user: this.serializeUser(withdrawal.user),
      tokens: Number(withdrawal.tokens),
      amount: Number(withdrawal.amount),
      currency: withdrawal.currency,
      moneyPerToken: Number(withdrawal.moneyPerToken),
      phone: withdrawal.phone,
      status: withdrawal.status,
      paymentTransactionId: withdrawal.paymentTransactionId,
      paymentTransaction: this.serializePayment(withdrawal.paymentTransaction),
      requestedAt: withdrawal.requestedAt,
      processedAt: withdrawal.processedAt,
      failureReason: withdrawal.failureReason,
      createdAt: withdrawal.createdAt,
      updatedAt: withdrawal.updatedAt,
    };
  }

  private serializeUser(user?: User | null) {
    if (!user) {
      return null;
    }
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      role: user.role,
      status: user.status,
      isDriver: user.isDriver,
      isActive: user.isActive,
    };
  }

  private serializePayment(payment?: PaymentTransaction | null) {
    if (!payment) {
      return null;
    }
    return {
      id: payment.id,
      userId: payment.userId,
      purpose: payment.purpose,
      relatedEntityType: payment.relatedEntityType,
      relatedEntityId: payment.relatedEntityId,
      provider: payment.provider,
      method: payment.method,
      status: payment.status,
      reference: payment.reference,
      orderNumber: payment.orderNumber,
      providerReference: payment.providerReference,
      providerStatusCode: payment.providerStatusCode,
      providerMessage: payment.providerMessage,
      amount: Number(payment.amount),
      currency: payment.currency,
      description: payment.description,
      phone: payment.phone,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }

  private async ensureAdmin(adminId: string): Promise<void> {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Seuls les administrateurs peuvent rapprocher un retrait',
      );
    }
  }
}
