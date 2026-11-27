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
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { AdminUserReferralsQuery } from './dto/admin-user-referrals.dto';
import { parseRegistrationRange } from './dto/admin-users.dto';
import { buildUserReferralsSpreadsheet, type AdminUserReferralItem } from './user-referrals-spreadsheet';
import { isSuperAdminRole } from '../users/user-role.policy';
import { RetryPayoutDto } from '../payments/dto/retry-payout.dto';
import { payoutRetryDetails } from '../payments/payout-retry';
import {
  buildReferralAccountsSpreadsheet,
  buildReferralRewardsSpreadsheet,
  buildReferralWithdrawalsSpreadsheet,
} from './admin-spreadsheets';
import type { SpreadsheetDownload } from './spreadsheet';
import { streamExport, exportCreatedPages, exportOffsetPages } from './streaming-export';
import { ResolvePayoutNotPaidDto } from '../payments/dto/resolve-payout-not-paid.dto';
import { payoutRecoveryActions } from '../payments/payout-recovery-actions';
import { ReferralWithdrawalResolution } from '../referrals/entities/referral-withdrawal-resolution.entity';

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

  async getUserReferral(userId: string) {
    const [profile, filleuls] = await Promise.all([
      this.profileRepository.findOne({
        where: { userId }, relations: ['referredByUser'],
      }),
      this.profileRepository.find({
        where: { referredByUserId: userId },
        relations: ['user'],
        order: { referredAt: 'DESC' },
        take: 50,
      }),
    ]);
    return {
      referrer: this.serializeUser(profile?.referredByUser),
      referredAt: profile?.referredAt ?? null,
      attributionProvider: profile?.attributionProvider ?? null,
      canAttach: !profile?.referredByUserId,
      filleuls: filleuls.flatMap((item) => {
        const user = this.serializeUser(item.user);
        return user ? [{ user, referredAt: item.referredAt ?? null }] : [];
      }),
    };
  }

  async searchReferrers(search?: string) {
    const term = search?.trim() ?? '';
    if (term.length < 2) return { users: [] };
    const users = await this.userRepository.createQueryBuilder('candidate')
      .select(this.userSelect('candidate'))
      .where('candidate.isActive = :active', { active: true })
      .andWhere('candidate.status NOT IN (:...excluded)', { excluded: [UserStatus.INACTIVE, UserStatus.SUSPENDED] })
      .andWhere(new Brackets((query) => {
        query.where('candidate.firstName ILIKE :term')
          .orWhere('candidate.lastName ILIKE :term')
          .orWhere("concat(candidate.firstName, ' ', candidate.lastName) ILIKE :term")
          .orWhere('candidate.phone ILIKE :term')
          .orWhere('candidate.email ILIKE :term')
          .orWhere('CAST(candidate.id AS TEXT) ILIKE :term');
      }), { term: `%${term.slice(0, 160).replace(/[\\%_]/g, '\\$&')}%` })
      .orderBy('candidate.firstName', 'ASC').addOrderBy('candidate.id', 'ASC')
      .take(15).getMany();
    return { users: users.map((user) => this.serializeUser(user)) };
  }

  async getUserReferrals(userId: string, filters: AdminUserReferralsQuery) {
    await this.ensureReferralUserExists(userId);
    const { pageNumber, pageSize } = this.normalizePagination(filters.page, filters.limit);
    const [profiles, total] = await this.createUserReferralsQuery(userId, filters)
      .skip((pageNumber - 1) * pageSize).take(pageSize).getManyAndCount();
    return { items: profiles.map(profile => this.serializeUserReferral(profile)), total, page: pageNumber, limit: pageSize };
  }

  async exportUserReferrals(userId: string, filters: AdminUserReferralsQuery): Promise<SpreadsheetDownload> {
    await this.ensureReferralUserExists(userId);
    const query = this.createUserReferralsQuery(userId, filters);
    // The export never applies the displayed page/limit. It reads bounded batches.
    return streamExport(exportOffsetPages(query, 'referredUser'), profiles => ({
      buffer: buildUserReferralsSpreadsheet(profiles.map(profile => this.serializeUserReferral(profile))),
      filename: `filleuls-zwanga-${userId}-${new Date().toISOString().slice(0, 10)}.xls`,
      contentType: 'application/vnd.ms-excel; charset=utf-8',
    }));
  }

  private async ensureReferralUserExists(userId: string) {
    if (!await this.userRepository.findOne({ where: { id: userId }, select: { id: true } }))
      throw new NotFoundException('Utilisateur introuvable.');
  }

  private createUserReferralsQuery(userId: string, filters: AdminUserReferralsQuery) {
    if (filters.role && !Object.values(UserRole).includes(filters.role))
      throw new BadRequestException('Rôle de compte invalide.');
    const registered = parseRegistrationRange(filters.registeredFrom, filters.registeredTo);
    const query = this.profileRepository.createQueryBuilder('profile')
      .innerJoinAndSelect('profile.user', 'referredUser')
      .select(['profile.id', 'profile.userId', 'profile.referredAt', ...this.userSelect('referredUser'), 'referredUser.createdAt'])
      .where('profile.referredByUserId = :referrerUserId', { referrerUserId: userId });
    if (filters.role) query.andWhere('referredUser.role = :referralRole', { referralRole: filters.role });
    if (registered.from) query.andWhere('referredUser.createdAt >= :registeredFrom', { registeredFrom: registered.from });
    if (registered.to) query.andWhere('referredUser.createdAt < :registeredTo', { registeredTo: registered.to });
    return query.orderBy('referredUser.createdAt', 'DESC').addOrderBy('referredUser.id', 'DESC');
  }

  private serializeUserReferral(profile: ReferralProfile): AdminUserReferralItem {
    const user = profile.user;
    return {
      id: profile.id,
      user: { id: user.id, firstName: user.firstName, lastName: user.lastName, phone: user.phone,
        email: user.email, role: user.role, status: user.status, isDriver: user.isDriver,
        isActive: user.isActive, createdAt: user.createdAt },
      referredAt: profile.referredAt ?? null,
    };
  }

  attachReferrer(adminId: string, userId: string, referrerUserId: string, reason: string) {
    return this.referralsService.attachUserByAdmin(adminId, userId, referrerUserId, reason);
  }

  async getAccounts(page: number = 1, limit: number = 25, search?: string) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const query = this.createAccountsQuery(search);

    const [accounts, total] = await query
      .orderBy('account.updatedAt', 'DESC')
      .addOrderBy('account.id', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    const referralCounts = await this.loadReferralCounts(
      accounts.map((account) => account.userId),
    );

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
    const query = this.createRewardsQuery(search, requestedStatus);

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
    const query = this.createWithdrawalsQuery(search, requestedStatus);

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
    await this.ensureSuperAdmin(adminId);
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
      await this.referralsService.recoverUnsentWithdrawal(withdrawalId, adminId);
    } else {
      await this.referralsService.checkWithdrawalStatus(
        withdrawal.userId,
        orderNumber,
      );
    }
    const reconciled = await this.withdrawalRepository.findOne({
      where: { id: withdrawalId },
      relations: ['user', 'paymentTransaction'],
    });
    if (!reconciled) {
      throw new NotFoundException('Retrait de parrainage introuvable');
    }
    return this.serializeWithdrawal(reconciled);
  }

  async getWithdrawalDetail(withdrawalId: string) {
    const withdrawal = await this.withdrawalRepository.findOne({
      where: { id: withdrawalId }, relations: ['user', 'paymentTransaction'],
    });
    if (!withdrawal) throw new NotFoundException('Retrait de parrainage introuvable');
    const resolution = await this.withdrawalRepository.manager.findOneBy(
      ReferralWithdrawalResolution, { withdrawalId },
    );
    return {
      ...this.serializeWithdrawal(withdrawal),
      ...await payoutRetryDetails(this.withdrawalRepository.manager, 'referral_withdrawal', withdrawal, withdrawal.paymentTransaction),
      resolution,
      lateSuccessAfterRelease: !!resolution && withdrawal.status === ReferralWithdrawalStatus.SUCCEEDED,
    };
  }

  async resolveWithdrawalNotPaid(adminId: string, withdrawalId: string, dto: ResolvePayoutNotPaidDto) {
    await this.ensureSuperAdmin(adminId);
    await this.referralsService.resolveWithdrawalNotPaid(adminId, withdrawalId, dto);
    return this.getWithdrawalDetail(withdrawalId);
  }

  async retryWithdrawal(adminId: string, withdrawalId: string, dto: RetryPayoutDto) {
    await this.ensureSuperAdmin(adminId);
    const replacement = await this.referralsService.retryWithdrawal(adminId, withdrawalId, dto);
    return this.getWithdrawalDetail(replacement.id);
  }

  async exportAccounts(search?: string): Promise<SpreadsheetDownload> {
    const query = this.createAccountsQuery(search)
      .orderBy('account.updatedAt', 'DESC')
      .addOrderBy('account.id', 'DESC');
    return streamExport(exportOffsetPages(query, 'account'), async accounts => {
      const referralCounts = await this.loadReferralCounts(accounts.map(account => account.userId));
      return buildReferralAccountsSpreadsheet((accounts as AdminReferralAccount[]).map(account => ({
        ...this.serializeAccount(account), directReferralsCount: referralCounts.get(account.userId) ?? 0,
      })));
    });
  }

  async exportRewards(
    search?: string,
    requestedStatus?: string,
  ): Promise<SpreadsheetDownload> {
    return streamExport(exportCreatedPages(this.createRewardsQuery(search, requestedStatus), 'reward'),
      rewards => buildReferralRewardsSpreadsheet(rewards.map(reward => this.serializeReward(reward))));
  }

  async exportWithdrawals(
    search?: string,
    requestedStatus?: string,
  ): Promise<SpreadsheetDownload> {
    return streamExport(exportCreatedPages(this.createWithdrawalsQuery(search, requestedStatus), 'withdrawal', 'requestedAt'),
      withdrawals => buildReferralWithdrawalsSpreadsheet(withdrawals.map(withdrawal => this.serializeWithdrawal(withdrawal))));
  }

  private normalizePagination(page: number, limit: number) {
    const pageNumber = Math.max(Number(page) || 1, 1);
    const pageSize = Math.min(
      Math.max(Number(limit) || 25, 1),
      this.maxPageLimit,
    );
    return { pageNumber, pageSize };
  }

  private createAccountsQuery(search?: string) {
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
    return query;
  }

  private createRewardsQuery(search?: string, requestedStatus?: string) {
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
    return query;
  }

  private createWithdrawalsQuery(search?: string, requestedStatus?: string) {
    const status = this.normalizeWithdrawalStatus(requestedStatus);
    const query = this.withdrawalRepository
      .createQueryBuilder('withdrawal')
      .leftJoinAndSelect('withdrawal.paymentTransaction', 'withdrawalPayment')
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
    return query;
  }

  private async loadReferralCounts(referrerIds: string[]) {
    const referralCounts = new Map<string, number>();
    if (referrerIds.length === 0) {
      return referralCounts;
    }

    const countRows = await this.profileRepository
      .createQueryBuilder('profile')
      .select('profile.referredByUserId', 'referrerUserId')
      .addSelect('COUNT(profile.id)', 'directReferralsCount')
      .where('profile.referredByUserId IN (:...referrerIds)', { referrerIds })
      .groupBy('profile.referredByUserId')
      .getRawMany<{
        referrerUserId: string;
        directReferralsCount: string;
      }>();

    for (const row of countRows) {
      referralCounts.set(row.referrerUserId, Number(row.directReferralsCount));
    }
    return referralCounts;
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
    const pending = [ReferralWithdrawalStatus.PENDING, ReferralWithdrawalStatus.INITIATED].includes(withdrawal.status);
    const age = Date.now() - new Date(withdrawal.requestedAt ?? withdrawal.createdAt).getTime();
    const isStale = pending && Number.isFinite(age) && age >= 24 * 60 * 60_000;
    return {
      ...payoutRecoveryActions(withdrawal, withdrawal.paymentTransaction),
      isStale,
      requiresReview: pending && (isStale || !withdrawal.paymentTransaction?.orderNumber),
      canRetry: [ReferralWithdrawalStatus.FAILED, ReferralWithdrawalStatus.CANCELLED].includes(withdrawal.status),
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

  private async ensureSuperAdmin(adminId: string): Promise<void> {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || !isSuperAdminRole(admin.role)) {
      throw new ForbiddenException(
        'Seul un super administrateur peut rapprocher un retrait',
      );
    }
  }
}
