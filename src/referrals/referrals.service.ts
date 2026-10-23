import { hasCurrentApprovedIdentity } from '../users/current-identity';
import {
  REFERRAL_MIN_WITHDRAWAL_TOKENS,
  TOKEN_VALUE_CDF,
} from '../wallet/token-value.policy';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { firstValueFrom } from 'rxjs';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { PaymentsService } from '../payments/payments.service';
import { NotificationService } from '../notifications/notifications.service';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { isAdminRole } from '../users/user-role.policy';
import { RequestReferralWithdrawalDto } from './dto/referral.dto';
import { ResolvePayoutNotPaidDto } from '../payments/dto/resolve-payout-not-paid.dto';
import { resolveReferralWithdrawalNotPaid } from './referral-withdrawal-recovery';
import { HistoryPageQuery, historyContext, loadHistoryIds, orderHistory } from '../common/history-page';
import { reconcileReferralRewards } from './reward-reconciliation';
import {
  reserveAvailableReferralTokens,
  validateReferralWithdrawalTokens,
} from './referral-withdrawal-balance';
import { ReferralAccount } from './entities/referral-account.entity';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';
import { assertSameReferralIntent, referralWithdrawalKey, referralWithdrawalPhone } from './referral-withdrawal-intent';
import {
  ReferralBalanceBucket,
  ReferralLedgerEntry,
  ReferralLedgerEntryType,
} from './entities/referral-ledger-entry.entity';
import { ReferralProfile } from './entities/referral-profile.entity';
import {
  ReferralReward,
  ReferralRewardSourceType,
  ReferralRewardStatus,
} from './entities/referral-reward.entity';
import {
  ReferralWithdrawal,
  ReferralWithdrawalStatus,
} from './entities/referral-withdrawal.entity';

interface RewardSourceInput {
  referredUserId: string;
  sourceType: ReferralRewardSourceType;
  sourceEntityId: string;
  paymentTransactionId: string | null;
  grossAmount: number;
  sourceCurrency: string;
  eventAt: Date;
  cashReceiptAt?: Date;
}

export interface ReferralRegistrationAttribution {
  referralCode?: string | null;
  referralToken?: string | null;
  referralProvider?: 'chottulink' | 'branch' | null;
  referralReferringLink?: string | null;
  referralCapturedAt?: string | Date | null;
}

interface ReferralRegistrationResult {
  profile: ReferralProfile;
  newlyAttached: boolean;
  referrer: {
    userId: string;
    firstName: string;
    fcmToken: string | null;
  } | null;
  referredFirstName: string;
  attributionBonusTokens: number;
}

interface AdminReferralAssignment {
  adminId: string;
  referrerUserId: string;
  reason: string;
}

@Injectable()
export class ReferralsService implements OnModuleInit {
  private readonly rewardReconciliations = new Map<string, Promise<void>>();
  private readonly shareLinkRefreshes = new Map<string, Promise<void>>();
  private readonly shareLinkRefreshAfter = new Map<string, number>();
  private readonly logger = new Logger(ReferralsService.name);
  private readonly WITHDRAWAL_RELATED_ENTITY_TYPE = 'referral_withdrawal';
  private readonly DEFAULT_SUBSCRIPTION_REWARD_RATE = 0.01;
  private readonly MAX_SUBSCRIPTION_REWARD_RATE = 0.01;
  private readonly DEFAULT_BOOKING_REWARD_RATE = 0.01;
  private readonly MAX_BOOKING_REWARD_RATE = 0.01;
  private readonly DEFAULT_PLATFORM_COMMISSION_RATE = 0.05;
  private readonly DEFAULT_HOLD_DAYS = 7;
  private readonly DEFAULT_PROGRAM_MONTHS = 12;
  private readonly DEFAULT_ATTRIBUTION_DAYS = 30;
  private readonly DEFAULT_SHARE_LINK_REFRESH_DAYS = 330;

  constructor(
    @InjectRepository(ReferralProfile)
    private readonly profileRepository: Repository<ReferralProfile>,
    @InjectRepository(ReferralAccount)
    private readonly accountRepository: Repository<ReferralAccount>,
    @InjectRepository(ReferralReward)
    private readonly rewardRepository: Repository<ReferralReward>,
    @InjectRepository(ReferralLedgerEntry)
    private readonly ledgerRepository: Repository<ReferralLedgerEntry>,
    @InjectRepository(ReferralWithdrawal)
    private readonly withdrawalRepository: Repository<ReferralWithdrawal>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private readonly kycRepository: Repository<KycDocument>,
    @InjectRepository(PaymentTransaction)
    private readonly paymentRepository: Repository<PaymentTransaction>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly paymentsService: PaymentsService,
    private readonly notificationService: NotificationService,
  ) {}

  onModuleInit() {
    this.paymentsService.registerSettlement?.(
      PaymentPurpose.REFERRAL_PAYOUT,
      async (payment) => {
        await this.applyPaymentToWithdrawal(payment);
      },
    );
  }

  async validateCode(code: string) {
    const profile = await this.findUsableReferrerProfile(code);
    return {
      valid: true,
      code: profile.code,
      referrer: {
        firstName: profile.user.firstName,
      },
    };
  }

  async assertReferralCode(code?: string | null): Promise<void> {
    if (!code?.trim()) {
      return;
    }
    await this.findUsableReferrerProfile(code);
  }

  async resolveAttribution(referralToken: string) {
    const profile = await this.findUsableReferrerByToken(referralToken);
    return {
      valid: true,
      referrer: {
        firstName: profile.user.firstName,
      },
    };
  }

  async assertReferralAttribution(
    attribution: ReferralRegistrationAttribution,
  ): Promise<void> {
    const code = this.normalizeCode(attribution.referralCode);
    const token = this.normalizeToken(attribution.referralToken);
    if (!code && !token) {
      return;
    }
    this.validateAttributionCapturedAt(attribution.referralCapturedAt, token);
    const [codeProfile, tokenProfile] = await Promise.all([
      code ? this.findUsableReferrerProfile(code) : Promise.resolve(null),
      token ? this.findUsableReferrerByToken(token) : Promise.resolve(null),
    ]);
    if (
      codeProfile &&
      tokenProfile &&
      codeProfile.userId !== tokenProfile.userId
    ) {
      throw new BadRequestException(
        'Les informations de parrainage ne correspondent pas au même parrain',
      );
    }
  }

  async registerUser(
    userId: string,
    attribution: ReferralRegistrationAttribution = {},
  ): Promise<ReferralProfile> {
    const result = await this.registerUserInternal(userId, attribution);
    await this.afterReferralAssignment(userId, result);
    return result.profile;
  }

  async registerUserInTransaction(
    manager: EntityManager,
    userId: string,
    attribution: ReferralRegistrationAttribution = {},
  ): Promise<() => Promise<void>> {
    const result = await this.registerUserInternal(userId, attribution, undefined, manager);
    // Network notifications are sent only once the caller's transaction commits.
    return () => this.afterReferralAssignment(userId, result);
  }

  async attachAuthenticatedUser(
    userId: string,
    attribution: ReferralRegistrationAttribution,
  ) {
    await this.assertReferralAttribution(attribution);
    const result = await this.registerUserInternal(userId, attribution);
    await this.afterReferralAssignment(userId, result);

    if (!result.profile.referredByUserId || !result.referrer) {
      throw new BadRequestException(
        "L'attribution de parrainage n'a pas pu être enregistrée",
      );
    }

    return {
      attached: true,
      newlyAttached: result.newlyAttached,
      referredAt: result.profile.referredAt,
      referrer: {
        firstName: result.referrer.firstName,
      },
    };
  }

  async attachUserByAdmin(
    adminId: string,
    userId: string,
    referrerUserId: string,
    requestedReason: string,
  ) {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || !isAdminRole(admin.role)) {
      throw new ForbiddenException('Administrateur requis');
    }
    const reason = requestedReason.trim();
    if (reason.length < 10 || reason.length > 300) {
      throw new BadRequestException('Le motif doit contenir entre 10 et 300 caractères');
    }
    const result = await this.registerUserInternal(userId, {}, {
      adminId, referrerUserId, reason,
    });
    await this.afterReferralAssignment(userId, result);
    return {
      attached: true,
      newlyAttached: result.newlyAttached,
      userId,
      referrerUserId: result.profile.referredByUserId,
      referredAt: result.profile.referredAt,
      attributionBonusTokens: result.attributionBonusTokens,
    };
  }

  private async registerUserInternal(
    userId: string,
    attribution: ReferralRegistrationAttribution = {},
    adminAssignment?: AdminReferralAssignment,
    registrationManager?: EntityManager,
  ): Promise<ReferralRegistrationResult> {
    const normalizedCode = this.normalizeCode(attribution.referralCode);
    const normalizedToken = this.normalizeToken(attribution.referralToken);
    const capturedAt = this.validateAttributionCapturedAt(
      attribution.referralCapturedAt,
      normalizedToken,
    );

    const work = async (manager: EntityManager): Promise<ReferralRegistrationResult> => {
      if (normalizedCode || normalizedToken || adminAssignment) {
        // Serialize graph changes, including mobile attribution, so two
        // simultaneous assignments cannot introduce a referral cycle.
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          'zwanga:referral-attribution',
        ]);
      }
      await this.lockReferralUser(manager, userId);

      const user = await manager.findOne(User, {
        where: { id: userId },
        select: { id: true, firstName: true, fcmToken: true, isActive: true, status: true },
      });
      if (!user) {
        throw new NotFoundException('Utilisateur introuvable');
      }

      let profile = await manager.findOne(ReferralProfile, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!profile) {
        profile = manager.create(ReferralProfile, {
          userId,
          code: await this.generateUniqueCode(manager),
          linkToken: await this.generateUniqueLinkToken(manager),
          shareLinkUrl: null,
          shareLinkGeneratedAt: null,
          referredByUserId: null,
          referredAt: null,
          attributionProvider: null,
          attributionLinkToken: null,
          attributionReferringLink: null,
          attributionCapturedAt: null,
          qualifiedAt: null,
          rewardWindowEndsAt: null,
        });
      }

      let newlyAttached = false;
      let resolvedReferrer: ReferralRegistrationResult['referrer'] = null;

      if (normalizedCode || normalizedToken || adminAssignment) {
        const codeProfile = normalizedCode
          ? await manager.findOne(ReferralProfile, {
              where: { code: normalizedCode },
            })
          : null;
        const tokenProfile = normalizedToken
          ? await manager.findOne(ReferralProfile, {
              where: { linkToken: normalizedToken },
            })
          : null;
        if (
          codeProfile &&
          tokenProfile &&
          codeProfile.userId !== tokenProfile.userId
        ) {
          throw new BadRequestException(
            'Les informations de parrainage ne correspondent pas au même parrain',
          );
        }
        const referrerProfile = tokenProfile ?? codeProfile;
        const referrerUserId = adminAssignment?.referrerUserId ?? referrerProfile?.userId;
        const referrerUser = referrerUserId
          ? await manager.findOne(User, {
              where: { id: referrerUserId },
              select: { id: true, firstName: true, fcmToken: true, isActive: true, status: true },
            })
          : null;
        if (!referrerUserId || !this.isUserEligibleAsReferrer(referrerUser)) {
          throw new BadRequestException(
            'Code de parrainage invalide ou inactif',
          );
        }
        resolvedReferrer = {
          userId: referrerUserId,
          firstName: referrerUser!.firstName,
          fcmToken: referrerUser!.fcmToken,
        };

        if (profile.referredByUserId) {
          if (profile.referredByUserId !== referrerUserId) {
            throw new BadRequestException(
              'Le parrain d’un compte déjà inscrit ne peut pas être modifié',
            );
          }
        } else {
          if (referrerUserId === userId) {
            throw new BadRequestException(
              'Vous ne pouvez pas utiliser votre propre code de parrainage',
            );
          }
          await this.assertNoReferralCycle(manager, userId, referrerUserId);
          profile.referredByUserId = referrerUserId;
          profile.referredAt = new Date();
          profile.attributionProvider = adminAssignment ? 'admin' : normalizedToken
            ? this.resolveAttributionProvider(attribution)
            : 'legacy_code';
          profile.attributionLinkToken = normalizedToken;
          profile.attributionReferringLink =
            attribution.referralReferringLink?.trim().slice(0, 500) || null;
          profile.attributionCapturedAt = capturedAt ?? new Date();
          profile.attributionAdminId = adminAssignment?.adminId ?? null;
          profile.attributionAdminReason = adminAssignment?.reason ?? null;
          newlyAttached = true;
        }
      }

      profile = await manager.save(profile);
      await this.getOrCreateAccount(manager, userId);
      // Attribution is not a financial event. Only eligible paid transactions
      // may credit the referrer; legacy configuration must not restore a bonus.
      return {
        profile,
        newlyAttached,
        referrer: resolvedReferrer,
        referredFirstName: user.firstName,
        attributionBonusTokens: 0,
      };
    };
    return registrationManager ? work(registrationManager) : this.dataSource.transaction(work);
  }

  private async assertNoReferralCycle(manager: EntityManager, userId: string, referrerUserId: string) {
    const visited = new Set([userId]);
    let ancestor: string | null = referrerUserId;
    while (ancestor) {
      if (visited.has(ancestor)) {
        throw new BadRequestException('Ce rattachement créerait une boucle de parrainage');
      }
      visited.add(ancestor);
      const profile = await manager.findOne(ReferralProfile, {
        where: { userId: ancestor }, select: { referredByUserId: true },
      });
      ancestor = profile?.referredByUserId ?? null;
    }
  }

  private async afterReferralAssignment(
    userId: string,
    result: ReferralRegistrationResult,
  ): Promise<void> {
    if (!result.newlyAttached || !result.referrer) {
      return;
    }

    this.logger.log(
      `Referral attribution attached: referredUserId=${userId}, referrerUserId=${result.referrer.userId}, provider=${result.profile.attributionProvider}`,
    );

    if (!result.referrer.fcmToken) {
      return;
    }

    try {
      await this.notificationService.sendNotification(
        result.referrer.fcmToken,
        'Nouveau filleul Zwanga',
        `${result.referredFirstName} a rejoint votre réseau de parrainage. Vos commissions seront calculées sur ses paiements éligibles.`,
        {
          type: 'referral_new_referral',
          referredUserId: userId,
          attributionBonusTokens: result.attributionBonusTokens,
        },
        result.referrer.userId,
      );
    } catch (error) {
      this.logger.warn(
        `Referral notification failed for referrerUserId=${result.referrer.userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getSummary(userId: string) {
    const { profile, account } = await this.ensureProfileAndAccount(userId);
    const [referralCount, rewardCount, kycApproved] = await Promise.all([
      this.profileRepository.count({ where: { referredByUserId: userId } }),
      this.rewardRepository.count({ where: { referrerUserId: userId } }),
      hasCurrentApprovedIdentity(this.kycRepository, userId),
    ]);
    const payoutCurrency = this.getPayoutCurrency();
    const payoutMoneyPerToken = this.getMoneyPerToken(payoutCurrency);
    const shareLink = this.readShareLink(profile);
    const bookingRewardRate = this.getRewardRate(
      ReferralRewardSourceType.BOOKING_PAYMENT,
    );
    const subscriptionRewardRate = this.getRewardRate(
      ReferralRewardSourceType.SUBSCRIPTION_PAYMENT,
    );
    const platformCommissionRate = this.getPlatformCommissionRate();
    const platformRetainedBookingCommissionRate = this.roundRate(
      Math.max(platformCommissionRate - bookingRewardRate, 0),
    );

    return {
      code: profile.code,
      shareLink,
      referralCount,
      rewardCount,
      attribution: {
        hasReferrer: Boolean(profile.referredByUserId),
        referredAt: profile.referredAt,
      },
      balances: {
        pendingTokens: Number(account.pendingTokens),
        availableTokens: Number(account.availableTokens),
        reservedTokens: Number(account.reservedTokens),
        withdrawnTokens: Number(account.withdrawnTokens),
        currency: account.currency,
        availableAmount: this.roundMoney(
          Number(account.availableTokens) * payoutMoneyPerToken,
        ),
        payoutCurrency,
      },
      withdrawal: {
        enabled: true,
        blocked:
          !kycApproved ||
          Number(account.availableTokens) < this.getMinimumWithdrawalTokens(),
        kycApproved,
        minimumTokens: this.getMinimumWithdrawalTokens(),
        moneyPerToken: payoutMoneyPerToken,
        currency: payoutCurrency,
      },
      rules: {
        rewardRate: bookingRewardRate,
        subscriptionRewardRate,
        bookingRewardRate,
        bookingPaymentModes: [TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS, TripPaymentMode.CASH],
        cashRewardRequiresReceipt: true,
        bookingRewardFunding: 'platform_commission_share',
        platformCommissionRate,
        platformRetainedBookingCommissionRate,
        attributionBonusTokens: 0, // Retained for older clients; no signup reward.
        eligiblePayments: [
          'subscription_flexpay',
          'subscription_pawapay',
          'booking_flexpay',
          'booking_pawapay',
          'booking_tokens',
          'booking_cash_confirmed',
        ],
        holdDays: this.getHoldDays(),
        rewardWindowMonths: this.getProgramMonths(),
        rewardWindowStartsAt: 'first_eligible_successful_payment',
        promotionalTokensWithdrawable: false,
      },
    };
  }

  async getReferrals(userId: string, ids?: string[]) {
    const profiles = await this.profileRepository.find({
        where: { referredByUserId: userId, ...(ids ? { id: In(ids) } : {}) },
        relations: ['user'],
        order: { referredAt: 'DESC' },
      });
    if (!profiles.length) return [];
    const rawEarnings = await this.rewardRepository
        .createQueryBuilder('reward')
        .select('reward.referredUserId', 'referredUserId')
        .addSelect(
          `COUNT(*) FILTER (WHERE reward.status <> :reversed)`,
          'rewardCount',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN reward.status <> :reversed THEN reward.rewardTokens ELSE 0 END), 0)`,
          'earnedTokens',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN reward.status = :pending THEN reward.rewardTokens ELSE 0 END), 0)`,
          'pendingTokens',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN reward.status = :available THEN reward.rewardTokens ELSE 0 END), 0)`,
          'releasedTokens',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN reward.status = :reversed THEN reward.rewardTokens ELSE 0 END), 0)`,
          'reversedTokens',
        )
        .where('reward.referrerUserId = :userId', { userId })
        .andWhere('reward.referredUserId IN (:...referredIds)', { referredIds: profiles.map(profile => profile.userId) })
        .setParameters({
          pending: ReferralRewardStatus.PENDING,
          available: ReferralRewardStatus.AVAILABLE,
          reversed: ReferralRewardStatus.REVERSED,
        })
        .groupBy('reward.referredUserId')
        .getRawMany<{
          referredUserId: string;
          rewardCount: string;
          earnedTokens: string;
          pendingTokens: string;
          releasedTokens: string;
          reversedTokens: string;
        }>();
    const earningsByUserId = new Map(
      rawEarnings.map((earning) => [earning.referredUserId, earning]),
    );
    const payoutCurrency = this.getPayoutCurrency();
    const moneyPerToken = this.getMoneyPerToken(payoutCurrency);

    return profiles.map((profile) => {
      const earning = earningsByUserId.get(profile.userId);
      const earnedTokens = this.roundMoney(Number(earning?.earnedTokens ?? 0));
      return {
        userId: profile.userId,
        firstName: profile.user.firstName,
        lastNameInitial: profile.user.lastName
          ? `${profile.user.lastName.charAt(0).toUpperCase()}.`
          : '',
        referredAt: profile.referredAt,
        qualifiedAt: profile.qualifiedAt,
        rewardWindowEndsAt: profile.rewardWindowEndsAt,
        earnings: {
          rewardCount: Number(earning?.rewardCount ?? 0),
          earnedTokens,
          pendingTokens: this.roundMoney(Number(earning?.pendingTokens ?? 0)),
          releasedTokens: this.roundMoney(Number(earning?.releasedTokens ?? 0)),
          reversedTokens: this.roundMoney(Number(earning?.reversedTokens ?? 0)),
          earnedAmount: this.roundMoney(earnedTokens * moneyPerToken),
          currency: payoutCurrency,
        },
      };
    });
  }

  async getRewards(userId: string, ids?: string[]) {
    const rewards = await this.rewardRepository.find({
      where: { referrerUserId: userId, ...(ids ? { id: In(ids) } : {}) },
      relations: ['referredUser'],
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return rewards.map((reward) => ({
      id: reward.id,
      sourceType: reward.sourceType,
      sourceEntityId: reward.sourceEntityId,
      grossAmount: Number(reward.grossAmount),
      sourceCurrency: reward.sourceCurrency,
      rate: Number(reward.rate),
      rewardAmount: Number(reward.rewardAmount),
      rewardTokens: Number(reward.rewardTokens),
      status: reward.status,
      holdUntil: reward.holdUntil,
      availableAt: reward.availableAt,
      reversedAt: reward.reversedAt,
      reversalReason: reward.reversalReason,
      createdAt: reward.createdAt,
      referredUser: {
        firstName: reward.referredUser.firstName,
        lastNameInitial: reward.referredUser.lastName
          ? `${reward.referredUser.lastName.charAt(0).toUpperCase()}.`
          : '',
      },
    }));
  }

  async getLedger(userId: string): Promise<ReferralLedgerEntry[]> {
    await this.ensureProfileAndAccount(userId);
    return this.ledgerRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  async getWithdrawals(userId: string, ids?: string[]) {
    const withdrawals = await this.withdrawalRepository.find({
      where: { userId, ...(ids ? { id: In(ids) } : {}) },
      relations: ['paymentTransaction'],
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return withdrawals.map((withdrawal) => ({
      id: withdrawal.id,
      tokens: Number(withdrawal.tokens),
      amount: Number(withdrawal.amount),
      currency: withdrawal.currency,
      moneyPerToken: Number(withdrawal.moneyPerToken),
      phone: withdrawal.phone,
      status: withdrawal.status,
      paymentTransactionId: withdrawal.paymentTransactionId,
      orderNumber: withdrawal.paymentTransaction?.orderNumber ?? null,
      paymentMessage: withdrawal.status === ReferralWithdrawalStatus.CANCELLED
        ? 'Retrait annulé dans Zwanga ; les jetons ont été rendus disponibles.'
        : withdrawal.paymentTransaction
        ? this.paymentsService.getClientPaymentMessage(
            withdrawal.paymentTransaction,
          )
        : null,
      requestedAt: withdrawal.requestedAt,
      processedAt: withdrawal.processedAt,
      failureReason: withdrawal.failureReason,
      createdAt: withdrawal.createdAt,
      updatedAt: withdrawal.updatedAt,
    }));
  }

  async getReferralPage(userId: string, options: HistoryPageQuery) {
    const page = await loadHistoryIds(this.profileRepository.createQueryBuilder('profile')
      .where('profile.referredByUserId = :userId', { userId }), options,
      historyContext(options, 'referrals'), 'profile.id', 'COALESCE(profile.referredAt, profile.createdAt)');
    if (!page.ids.length) return { data: [], nextCursor: null };
    const profiles = await this.profileRepository.find({ where: { id: In(page.ids), referredByUserId: userId }, select: { id: true, userId: true } });
    const summaries = await this.getReferrals(userId, page.ids);
    const byUser = new Map(summaries.map(row => [row.userId, row]));
    return { data: orderHistory(page.ids, profiles).flatMap(row => byUser.has(row.userId) ? [byUser.get(row.userId)!] : []), nextCursor: page.nextCursor };
  }

  async getRewardPage(userId: string, options: HistoryPageQuery) {
    const page = await loadHistoryIds(this.rewardRepository.createQueryBuilder('reward')
      .where('reward.referrerUserId = :userId', { userId }), options,
      historyContext(options, 'referral-rewards'), 'reward.id', 'reward.createdAt');
    return { data: page.ids.length ? orderHistory(page.ids, await this.getRewards(userId, page.ids)) : [], nextCursor: page.nextCursor };
  }

  async getWithdrawalPage(userId: string, options: HistoryPageQuery) {
    const page = await loadHistoryIds(this.withdrawalRepository.createQueryBuilder('withdrawal')
      .where('withdrawal.userId = :userId', { userId }), options,
      historyContext(options, 'referral-withdrawals'), 'withdrawal.id', 'withdrawal.createdAt');
    return { data: page.ids.length ? orderHistory(page.ids, await this.getWithdrawals(userId, page.ids)) : [], nextCursor: page.nextCursor };
  }

  async awardSubscriptionReward(
    subscription: Subscription,
    payment: PaymentTransaction,
  ): Promise<ReferralReward | null> {
    if (
      subscription.isTrial ||
      // Welcome/promotional tokens pay Pro through the points flow. A stray
      // callback must never turn that free month into a referral cash reward.
      ['PTS', 'POINTS'].includes(subscription.currency?.toUpperCase()) ||
      subscription.paymentReference?.startsWith('POINTS-') ||
      payment.status !== PaymentStatus.SUCCEEDED ||
      ![PaymentProvider.FLEXPAY, PaymentProvider.PAWAPAY].includes(
        payment.provider,
      ) ||
      String(payment.purpose) !== String(PaymentPurpose.SUBSCRIPTION_PRO)
    ) {
      return null;
    }
    return this.awardReward({
      referredUserId: subscription.userId,
      sourceType: ReferralRewardSourceType.SUBSCRIPTION_PAYMENT,
      sourceEntityId: subscription.id,
      paymentTransactionId: payment.id,
      grossAmount: Number(payment.amount),
      sourceCurrency: payment.currency,
      eventAt: payment.paidAt ?? new Date(),
    });
  }

  async awardBookingReward(booking: Booking): Promise<ReferralReward | null> {
    if (booking.paymentMode === TripPaymentMode.CASH) {
      if (!this.isConfirmedCashBooking(booking)) return null;
      const [policy] = await this.dataSource.query(
        'SELECT "cashEligible" FROM referral_booking_jobs WHERE "bookingId" = $1', [booking.id],
      );
      if (!policy?.cashEligible) return null; // No retroactive cash rewards.
      return this.awardReward({
        referredUserId: booking.passengerId,
        sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
        sourceEntityId: booking.id,
        paymentTransactionId: null,
        grossAmount: Number(booking.cashReceivedAmount),
        sourceCurrency: booking.paymentCurrency,
        eventAt: booking.cashReceivedAt!,
        cashReceiptAt: booking.cashReceivedAt!,
      });
    }
    if (
      booking.status !== BookingStatus.COMPLETED ||
      !booking.droppedOff ||
      ![TripPaymentMode.ELECTRONIC, TripPaymentMode.POINTS].includes(
        booking.paymentMode,
      ) ||
      booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED
    ) {
      return null;
    }

    if (booking.paymentMode === TripPaymentMode.ELECTRONIC) {
      if (!booking.paymentTransactionId) {
        return null;
      }
      const payment = await this.paymentRepository.findOne({
        where: { id: booking.paymentTransactionId },
      });
      if (
        !payment ||
        payment.status !== PaymentStatus.SUCCEEDED ||
        ![PaymentProvider.FLEXPAY, PaymentProvider.PAWAPAY].includes(
          payment.provider,
        ) ||
        String(payment.purpose) !== String(PaymentPurpose.TRIP_BOOKING)
      ) {
        return null;
      }
      const grossAmount = booking.interruptionFareLocked
        ? Number(booking.paymentAmount)
        : Number(payment.amount);
      if (booking.interruptionFareLocked &&
          (booking.paymentAmount == null || !Number.isFinite(grossAmount) || grossAmount < 0 || grossAmount > Number(payment.amount) ||
            booking.paymentCurrency !== payment.currency)) {
        throw new BadRequestException('Le montant final du trajet doit être régularisé avant la commission de parrainage.');
      }
      if (grossAmount === 0) return null;
      return this.awardReward({
        referredUserId: booking.passengerId,
        sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
        sourceEntityId: booking.id,
        paymentTransactionId: payment.id,
        grossAmount,
        sourceCurrency: payment.currency,
        eventAt: payment.paidAt ?? booking.paidAt ?? new Date(),
      });
    }

    const grossAmount = Number(booking.paymentAmount ?? 0);
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
      return null;
    }

    // A success flag is not proof of a wallet debit. Never create withdrawable
    // referral money from an unbacked/fully refunded points payment.
    const entries = await this.dataSource.getRepository(WalletLedgerEntry).find({ where: {
      userId: booking.passengerId, relatedEntityType: 'booking', relatedEntityId: booking.id,
      type: In([WalletLedgerEntryType.BOOKING_PAYMENT, WalletLedgerEntryType.BOOKING_REFUND]),
    } });
    if (entries.some(entry => entry.type === WalletLedgerEntryType.BOOKING_REFUND)) return null;
    const debits = entries.filter(entry => entry.type === WalletLedgerEntryType.BOOKING_PAYMENT &&
      Number.isFinite(Number(entry.amount)) && Number(entry.amount) < 0 && ['PTS', 'POINTS'].includes(entry.currency));
    if (debits.length !== 1) throw new BadRequestException('Le débit en jetons doit être régularisé avant la commission de parrainage.');

    return this.awardReward({
      referredUserId: booking.passengerId,
      sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
      sourceEntityId: booking.id,
      paymentTransactionId: booking.paymentTransactionId ?? null,
      grossAmount,
      sourceCurrency: booking.paymentCurrency,
      eventAt: booking.paidAt ?? new Date(),
    });
  }

  async reverseSubscriptionReward(
    subscriptionId: string,
    reason: string,
  ): Promise<ReferralReward | null> {
    return this.reverseReward(
      ReferralRewardSourceType.SUBSCRIPTION_PAYMENT,
      subscriptionId,
      reason,
    );
  }

  private isConfirmedCashBooking(booking: Booking): boolean {
    return booking.status === BookingStatus.COMPLETED && booking.droppedOff &&
      booking.paymentMode === TripPaymentMode.CASH && booking.paymentStatus === BookingPaymentStatus.NOT_REQUIRED &&
      !!booking.cashReceivedAt && Number.isFinite(new Date(booking.cashReceivedAt).getTime()) &&
      !!booking.cashReceivedByDriverId && !!booking.paymentCurrency &&
      Number.isFinite(Number(booking.cashReceivedAmount)) && Number(booking.cashReceivedAmount) > 0 &&
      Number(booking.cashReceivedAmount) === Number(booking.paymentAmount);
  }

  async reverseBookingReward(
    bookingId: string,
    reason: string,
  ): Promise<ReferralReward | null> {
    return this.reverseReward(
      ReferralRewardSourceType.BOOKING_PAYMENT,
      bookingId,
      reason,
    );
  }

  async requestWithdrawal(
    userId: string,
    dto: RequestReferralWithdrawalDto,
  ): Promise<ReferralWithdrawal> {
    const tokens = validateReferralWithdrawalTokens(dto.tokens);
    const idempotencyKey = referralWithdrawalKey(dto.idempotencyKey);
    await this.releaseMatureRewardsForUser(userId);
    const kycApproved = await hasCurrentApprovedIdentity(this.kycRepository, userId);
    if (!kycApproved) {
      throw new BadRequestException(
        "Votre identité doit être vérifiée avant tout retrait.",
      );
    }
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    const requestedPhone = dto.phone?.trim() || user.phone;
    if (!requestedPhone) {
      throw new BadRequestException(
        'Un numéro Mobile Money est requis pour le retrait',
      );
    }
    const phone = referralWithdrawalPhone(requestedPhone);

    const currency = this.getPayoutCurrency();
    const moneyPerToken = this.getMoneyPerToken(currency);
    const amount = this.roundMoney(tokens * moneyPerToken);
    if (!Number.isFinite(amount) || amount > 99_999_999.99) throw new BadRequestException('Montant du retrait trop élevé.');
    const reservation = await this.reserveWithdrawal({
      userId,
      tokens,
      amount,
      currency,
      moneyPerToken,
      phone,
      idempotencyKey,
    });
    let withdrawal = reservation.withdrawal;
    // Only the creator can submit. Replays read the original state even if no
    // provider identifier exists yet; crash recovery must never send blindly.
    if (!reservation.created) return withdrawal;

    let payment: PaymentTransaction;
    try {
      payment = await this.paymentsService.initiatePayout({
        userId,
        purpose: PaymentPurpose.REFERRAL_PAYOUT,
        relatedEntityType: this.WITHDRAWAL_RELATED_ENTITY_TYPE,
        relatedEntityId: withdrawal.id,
        phone,
        amount,
        currency,
        description: `Retrait de ${tokens} jetons de parrainage Zwanga`,
        callbackUrl: this.getWithdrawalCallbackUrl(),
        referencePrefix: 'REF',
      });
    } catch (error) {
      // A local error after provider submission must not release spendable
      // tokens while that same transfer can still succeed.
      const recorded =
        await this.paymentsService.findLatestTransactionForRelatedEntity(
          this.WITHDRAWAL_RELATED_ENTITY_TYPE,
          withdrawal.id,
          userId,
        );
      if (recorded) return this.applyPaymentToWithdrawal(recorded, userId);
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        await this.failWithdrawal(withdrawal.id, error.message);
      }
      throw error;
    }

    // Une erreur locale apres une initiation FlexPay reussie ne doit jamais
    // liberer les jetons reserves. Le callback ou la verification de statut
    // reprendra la reconciliation de maniere idempotente.
    withdrawal = await this.applyPaymentToWithdrawal(payment, userId);
    return withdrawal;
  }

  async handleWithdrawalCallback(
    dto: FlexPayCallbackDto,
  ): Promise<ReferralWithdrawal> {
    const payment = await this.paymentsService.handleFlexPayCallback(dto);
    return this.applyPaymentToWithdrawal(payment);
  }

  async checkWithdrawalStatus(
    userId: string,
    orderNumber: string,
  ): Promise<ReferralWithdrawal> {
    const payment = await this.paymentsService.checkPaymentStatus(
      orderNumber,
      userId,
    );
    return this.applyPaymentToWithdrawal(payment, userId);
  }

  async getWithdrawalById(userId: string, id: string): Promise<ReferralWithdrawal> {
    const withdrawal = await this.withdrawalRepository.findOne({ where: { id, userId } });
    if (!withdrawal) throw new NotFoundException('Retrait de parrainage introuvable');
    return withdrawal;
  }

  /** Called only by the super-admin recovery API after authorization. */
  resolveWithdrawalNotPaid(adminId: string, id: string, dto: ResolvePayoutNotPaidDto) {
    return resolveReferralWithdrawalNotPaid(
      this.dataSource, this.paymentsService, adminId, id, dto,
      payment => this.applyPaymentToWithdrawal(payment),
      (manager, withdrawal, payment) => this.settleReservedWithdrawal(manager, withdrawal, false, payment),
    );
  }

  @Cron('*/5 * * * *', { waitForCompletion: true })
  async recoverUnsentWithdrawals(): Promise<void> {
    const rows = await this.withdrawalRepository.find({
      where: { status: ReferralWithdrawalStatus.PENDING, paymentTransactionId: IsNull(),
        requestedAt: LessThan(new Date(Date.now() - 15 * 60_000)) },
      select: { id: true },
      order: { recoveryCheckedAt: { direction: 'ASC', nulls: 'FIRST' }, requestedAt: 'ASC' },
      take: 50,
    });
    for (const row of rows) {
      try { await this.recoverUnsentWithdrawal(row.id); }
      catch { this.logger.warn(`REFERRAL_PAYOUT_RECOVERY_PENDING withdrawalId=${row.id}`); }
      finally { await this.withdrawalRepository.update(row.id, { recoveryCheckedAt: new Date() }); }
    }
  }

  async recoverUnsentWithdrawal(id: string, adminId?: string): Promise<ReferralWithdrawal> {
    const owner = await this.withdrawalRepository.findOne({ where: { id }, select: { id: true, userId: true } });
    if (!owner) throw new NotFoundException('Retrait de parrainage introuvable');
    const result = await this.dataSource.transaction(async manager => {
      // Submission uses the same locks. A late sender cannot send released funds.
      await manager.findOne(User, { where: { id: owner.userId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
      const withdrawal = await manager.findOne(ReferralWithdrawal, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!withdrawal) throw new NotFoundException('Retrait de parrainage introuvable');
      const payment = await manager.findOne(PaymentTransaction, { where: {
        relatedEntityType: this.WITHDRAWAL_RELATED_ENTITY_TYPE, relatedEntityId: id, userId: owner.userId,
      }, order: { createdAt: 'DESC' } });
      if (payment) return { withdrawal, payment };
      if (withdrawal.paymentTransactionId) throw new BadRequestException('Transaction liée introuvable : vérification du support requise.');
      if (withdrawal.status !== ReferralWithdrawalStatus.PENDING) return { withdrawal, payment: null };
      if (Date.now() - new Date(withdrawal.requestedAt).getTime() < 15 * 60_000)
        throw new BadRequestException('Cette réservation est encore récente. Réessayez après quinze minutes.');
      withdrawal.status = ReferralWithdrawalStatus.FAILED;
      withdrawal.processedAt = new Date();
      withdrawal.failureReason = `Réservation non envoyée, fonds libérés après vérification${adminId ? ` par admin ${adminId}` : ' automatique'}`;
      await this.settleReservedWithdrawal(manager, withdrawal, false, null);
      return { withdrawal: await manager.save(withdrawal), payment: null };
    });
    if (result.payment) {
      // Never release or resubmit an uncertain provider transfer.
      await this.paymentsService.reconcilePayment(result.payment.id);
      const payment = await this.paymentsService.findTransactionById(result.payment.id, owner.userId);
      return this.applyPaymentToWithdrawal(payment, owner.userId);
    }
    return result.withdrawal;
  }

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async releaseMatureRewards(): Promise<void> {
    const rewards = await this.rewardRepository.find({
      select: { id: true },
      where: {
        status: ReferralRewardStatus.PENDING,
        holdUntil: LessThanOrEqual(new Date()),
      },
      take: 500,
      order: { holdUntil: 'ASC' },
    });
    for (const reward of rewards) {
      try { await this.releaseRewardById(reward.id); }
      catch { this.logger.warn(`REFERRAL_REWARD_RELEASE_PENDING rewardId=${reward.id}`); }
    }
  }

  private async awardReward(
    input: RewardSourceInput,
  ): Promise<ReferralReward | null> {
    const existing = await this.rewardRepository.findOne({
      where: {
        sourceType: input.sourceType,
        sourceEntityId: input.sourceEntityId,
      },
    });
    if (existing) {
      return existing;
    }

    const grossAmount = this.normalizePositiveAmount(Number(input.grossAmount));
    const sourceCurrency = input.sourceCurrency.toUpperCase();
    const rate = this.getRewardRate(input.sourceType);
    const rewardAmount = this.roundMoney(grossAmount * rate);
    const sourceMoneyPerToken = this.getMoneyPerToken(sourceCurrency);
    const rewardTokens = this.roundMoney(rewardAmount / sourceMoneyPerToken);
    if (rewardTokens <= 0) {
      return null;
    }
    const eventAt = input.eventAt;

    try {
      return await this.dataSource.transaction(async (manager) => {
        if (input.cashReceiptAt) {
          const current = await manager.findOne(Booking, { where: { id: input.sourceEntityId }, lock: { mode: 'pessimistic_write' } });
          if (!current || !this.isConfirmedCashBooking(current)) return null;
          if (current.passengerId !== input.referredUserId || Number(current.cashReceivedAmount) !== input.grossAmount ||
              current.paymentCurrency !== input.sourceCurrency || new Date(current.cashReceivedAt!).getTime() !== new Date(input.cashReceiptAt).getTime())
            throw new ConflictException('Le reçu cash a changé. La commission sera recalculée.');
        }
        const duplicate = await manager.findOne(ReferralReward, {
          where: {
            sourceType: input.sourceType,
            sourceEntityId: input.sourceEntityId,
          },
        });
        if (duplicate) {
          return duplicate;
        }
        const referredProfile = await manager.findOne(ReferralProfile, {
          where: { userId: input.referredUserId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!referredProfile?.referredByUserId) {
          return null;
        }
        if (
          !referredProfile.referredAt ||
          eventAt < referredProfile.referredAt
        ) {
          this.logger.warn(
            `Referral reward skipped because payment predates attribution: referredUserId=${input.referredUserId}, sourceType=${input.sourceType}, sourceEntityId=${input.sourceEntityId}`,
          );
          return null;
        }
        const referrer = await manager.findOne(User, {
          where: { id: referredProfile.referredByUserId },
        });
        if (!this.isUserEligibleAsReferrer(referrer)) {
          this.logger.warn(
            `Referral reward skipped because referrer is inactive: referredUserId=${input.referredUserId}`,
          );
          return null;
        }

        if (!referredProfile.qualifiedAt) {
          referredProfile.qualifiedAt = eventAt;
          referredProfile.rewardWindowEndsAt = this.addMonths(
            eventAt,
            this.getProgramMonths(),
          );
          await manager.save(referredProfile);
        }
        if (
          !referredProfile.rewardWindowEndsAt ||
          eventAt > referredProfile.rewardWindowEndsAt
        ) {
          return null;
        }

        const account = await this.getOrCreateAccount(
          manager,
          referredProfile.referredByUserId,
          true,
        );
        let reward = manager.create(ReferralReward, {
          referrerUserId: referredProfile.referredByUserId,
          referredUserId: input.referredUserId,
          sourceType: input.sourceType,
          sourceEntityId: input.sourceEntityId,
          paymentTransactionId: input.paymentTransactionId,
          grossAmount,
          sourceCurrency,
          rate,
          rewardAmount,
          rewardTokens,
          sourceMoneyPerToken,
          status: ReferralRewardStatus.PENDING,
          holdUntil: this.addDays(eventAt, this.getHoldDays()),
          availableAt: null,
          reversedAt: null,
          reversalReason: null,
        });
        reward = await manager.save(reward);

        account.pendingTokens = this.roundMoney(
          Number(account.pendingTokens) + rewardTokens,
        );
        await manager.save(account);
        await this.createLedgerEntry(manager, account, {
          type: ReferralLedgerEntryType.REWARD_PENDING,
          bucket: ReferralBalanceBucket.PENDING,
          amountTokens: rewardTokens,
          balanceAfter: Number(account.pendingTokens),
          rewardId: reward.id,
          withdrawalId: null,
          paymentTransactionId: input.paymentTransactionId,
          description: `Commission de ${this.formatRate(rate)} en attente pour ${input.sourceType} ${input.sourceEntityId}`,
        });
        this.logger.log(
          `Referral reward recorded: rewardId=${reward.id}, referrer=${reward.referrerUserId}, referred=${reward.referredUserId}, rate=${rate}, tokens=${rewardTokens}`,
        );
        return reward;
      });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        return this.rewardRepository.findOne({
          where: {
            sourceType: input.sourceType,
            sourceEntityId: input.sourceEntityId,
          },
        });
      }
      throw error;
    }
  }

  private async reverseReward(
    sourceType: ReferralRewardSourceType,
    sourceEntityId: string,
    reason: string,
  ): Promise<ReferralReward | null> {
    return this.dataSource.transaction(async (manager) => {
      const reward = await manager.findOne(ReferralReward, {
        where: { sourceType, sourceEntityId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!reward || reward.status === ReferralRewardStatus.REVERSED) {
        return reward;
      }
      const account = await this.getOrCreateAccount(
        manager,
        reward.referrerUserId,
        true,
      );
      const bucket =
        reward.status === ReferralRewardStatus.PENDING
          ? ReferralBalanceBucket.PENDING
          : ReferralBalanceBucket.AVAILABLE;
      if (bucket === ReferralBalanceBucket.PENDING) {
        account.pendingTokens = this.roundMoney(
          Number(account.pendingTokens) - Number(reward.rewardTokens),
        );
      } else {
        account.availableTokens = this.roundMoney(
          Number(account.availableTokens) - Number(reward.rewardTokens),
        );
      }
      await manager.save(account);
      reward.status = ReferralRewardStatus.REVERSED;
      reward.reversedAt = new Date();
      reward.reversalReason = reason.slice(0, 500);
      await manager.save(reward);
      await this.createLedgerEntry(manager, account, {
        type: ReferralLedgerEntryType.REWARD_REVERSED,
        bucket,
        amountTokens: -Number(reward.rewardTokens),
        balanceAfter:
          bucket === ReferralBalanceBucket.PENDING
            ? Number(account.pendingTokens)
            : Number(account.availableTokens),
        rewardId: reward.id,
        withdrawalId: null,
        paymentTransactionId: reward.paymentTransactionId,
        description: `Annulation commission: ${reason}`.slice(0, 500),
      });
      return reward;
    });
  }

  private async releaseMatureRewardsForUser(userId: string): Promise<void> {
    return reconcileReferralRewards(this.dataSource, this.rewardReconciliations, userId,
      (id, manager) => this.releaseRewardById(id, manager));
  }

  private async releaseRewardById(rewardId: string, batchManager?: EntityManager): Promise<void> {
    const apply = async (manager: EntityManager) => {
      const reward = await manager.findOne(ReferralReward, {
        where: { id: rewardId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !reward ||
        reward.status !== ReferralRewardStatus.PENDING ||
        reward.holdUntil > new Date()
      ) {
        return;
      }
      const tokens = Number(reward.rewardTokens);
      const account = await this.getOrCreateAccount(
        manager,
        reward.referrerUserId,
        true,
      );
      account.pendingTokens = this.roundMoney(
        Number(account.pendingTokens) - tokens,
      );
      await manager.save(account);
      await this.createLedgerEntry(manager, account, {
        type: ReferralLedgerEntryType.REWARD_RELEASED,
        bucket: ReferralBalanceBucket.PENDING,
        amountTokens: -tokens,
        balanceAfter: Number(account.pendingTokens),
        rewardId: reward.id,
        withdrawalId: null,
        paymentTransactionId: reward.paymentTransactionId,
        description: `Sortie de la periode de retenue de la commission ${reward.id}`,
      });

      account.availableTokens = this.roundMoney(
        Number(account.availableTokens) + tokens,
      );
      await manager.save(account);
      await this.createLedgerEntry(manager, account, {
        type: ReferralLedgerEntryType.REWARD_RELEASED,
        bucket: ReferralBalanceBucket.AVAILABLE,
        amountTokens: tokens,
        balanceAfter: Number(account.availableTokens),
        rewardId: reward.id,
        withdrawalId: null,
        paymentTransactionId: reward.paymentTransactionId,
        description: `Commission disponible après retenue de ${this.getHoldDays()} jours`,
      });
      reward.status = ReferralRewardStatus.AVAILABLE;
      reward.availableAt = new Date();
      await manager.save(reward);
    };
    if (batchManager) await apply(batchManager);
    else await this.dataSource.transaction(apply);
  }

  private async reserveWithdrawal(input: {
    userId: string;
    tokens: number;
    amount: number;
    currency: string;
    moneyPerToken: number;
    phone: string;
    idempotencyKey?: string | null;
  }): Promise<{ withdrawal: ReferralWithdrawal; created: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      // Same user-first ordering as KYC decisions; recheck inside reservation.
      const user = await manager.findOne(User, { where: { id: input.userId }, lock: { mode: 'pessimistic_write' } });
      if (!user || !this.isUserEligibleAsReferrer(user)) {
        throw new BadRequestException('Ce compte ne peut pas demander de retrait.');
      }
      if (input.idempotencyKey) {
        const existing = await manager.findOne(ReferralWithdrawal, { where: { userId: input.userId, idempotencyKey: input.idempotencyKey } });
        if (existing) {
          assertSameReferralIntent(existing, input.tokens, input.phone);
          return { withdrawal: existing, created: false };
        }
      }
      const open = await manager.findOne(ReferralWithdrawal, {
        where: { userId: input.userId, status: In([ReferralWithdrawalStatus.PENDING, ReferralWithdrawalStatus.INITIATED]) },
        order: { requestedAt: 'DESC', id: 'DESC' },
      });
      if (open) {
        if (input.idempotencyKey) throw new ConflictException({ code: 'REFERRAL_WITHDRAWAL_IN_PROGRESS', message: 'Un retrait est déjà en cours. Vérifiez son statut avant de recommencer.', withdrawalId: open.id });
        assertSameReferralIntent(open, input.tokens, input.phone);
        return { withdrawal: open, created: false };
      }
      // Older store builds have no key: coalesce recent identical requests,
      // including a response lost just after the provider finished the payout.
      if (!input.idempotencyKey) {
        const recent = await manager.findOne(ReferralWithdrawal, {
          where: { userId: input.userId }, order: { requestedAt: 'DESC', id: 'DESC' },
        });
        if (recent && Date.now() - new Date(recent.processedAt ?? recent.updatedAt ?? recent.requestedAt).getTime() < 120_000) {
          assertSameReferralIntent(recent, input.tokens, input.phone);
          return { withdrawal: recent, created: false };
        }
      }
      if (!(await hasCurrentApprovedIdentity(manager.getRepository(KycDocument), input.userId))) {
        throw new BadRequestException('Votre identité doit être vérifiée avant tout retrait.');
      }
      const account = await this.getOrCreateAccount(
        manager,
        input.userId,
        true,
      );
      // Only the persisted AVAILABLE referral bucket funds this withdrawal.
      // Re-evaluate under the account lock so concurrent requests cannot reuse it.
      const balances = reserveAvailableReferralTokens(account, input.tokens);
      let withdrawal = manager.create(ReferralWithdrawal, {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey ?? null,
        tokens: input.tokens,
        amount: input.amount,
        currency: input.currency,
        moneyPerToken: input.moneyPerToken,
        phone: input.phone,
        status: ReferralWithdrawalStatus.PENDING,
        paymentTransactionId: null,
        requestedAt: new Date(),
        processedAt: null,
        failureReason: null,
      });
      withdrawal = await manager.save(withdrawal);

      account.availableTokens = balances.availableTokens;
      await manager.save(account);
      await this.createLedgerEntry(manager, account, {
        type: ReferralLedgerEntryType.WITHDRAWAL_RESERVED,
        bucket: ReferralBalanceBucket.AVAILABLE,
        amountTokens: -input.tokens,
        balanceAfter: Number(account.availableTokens),
        rewardId: null,
        withdrawalId: withdrawal.id,
        paymentTransactionId: null,
        description: `Jetons réservés pour le retrait ${withdrawal.id}`,
      });

      account.reservedTokens = balances.reservedTokens;
      await manager.save(account);
      await this.createLedgerEntry(manager, account, {
        type: ReferralLedgerEntryType.WITHDRAWAL_RESERVED,
        bucket: ReferralBalanceBucket.RESERVED,
        amountTokens: input.tokens,
        balanceAfter: Number(account.reservedTokens),
        rewardId: null,
        withdrawalId: withdrawal.id,
        paymentTransactionId: null,
        description: `Jetons en attente de confirmation FlexPay pour le retrait ${withdrawal.id}`,
      });
      return { withdrawal, created: true };
    });
  }

  private async applyPaymentToWithdrawal(
    payment: PaymentTransaction,
    userId?: string,
  ): Promise<ReferralWithdrawal> {
    if (
      String(payment.purpose) !== String(PaymentPurpose.REFERRAL_PAYOUT) ||
      payment.relatedEntityType !== this.WITHDRAWAL_RELATED_ENTITY_TYPE
    ) {
      throw new BadRequestException(
        'Cette transaction ne correspond pas à un retrait de parrainage',
      );
    }
    return this.dataSource.transaction(async (manager) => {
      if (!payment.userId || (userId && payment.userId !== userId))
        throw new BadRequestException('Bénéficiaire du retrait incohérent');
      await manager.findOne(User, {
        where: { id: payment.userId }, select: { id: true },
        lock: { mode: 'pessimistic_write' },
      });
      const withdrawal = await manager.findOne(ReferralWithdrawal, {
        where: payment.relatedEntityId
          ? { id: payment.relatedEntityId, ...(userId ? { userId } : {}) }
          : {
              paymentTransactionId: payment.id,
              ...(userId ? { userId } : {}),
            },
        lock: { mode: 'pessimistic_write' },
      });
      if (!withdrawal) {
        throw new NotFoundException('Retrait de parrainage introuvable');
      }
      // The callback snapshot can be older than a concurrently confirmed payment.
      // Settle from the locked persisted record, never from stale failure data.
      const current = await manager.findOne(PaymentTransaction, {
        where: { id: payment.id }, lock: { mode: 'pessimistic_write' },
      });
      if (!current || current.userId !== withdrawal.userId ||
          current.purpose !== PaymentPurpose.REFERRAL_PAYOUT ||
          current.relatedEntityType !== this.WITHDRAWAL_RELATED_ENTITY_TYPE ||
          current.relatedEntityId !== withdrawal.id ||
          Number(current.amount) !== Number(withdrawal.amount) ||
          current.currency !== withdrawal.currency || current.phone !== withdrawal.phone ||
          (withdrawal.paymentTransactionId && withdrawal.paymentTransactionId !== current.id))
        throw new BadRequestException('Transaction de retrait incohérente');
      payment = current;
      if (withdrawal.status === ReferralWithdrawalStatus.SUCCEEDED) {
        return withdrawal;
      }
      const wasAlreadyRefunded = [
        ReferralWithdrawalStatus.FAILED,
        ReferralWithdrawalStatus.CANCELLED,
      ].includes(withdrawal.status);
      if (wasAlreadyRefunded && payment.status !== PaymentStatus.SUCCEEDED) {
        return withdrawal;
      }
      withdrawal.paymentTransactionId = payment.id;
      withdrawal.status = this.mapPaymentStatus(payment.status);
      withdrawal.failureReason =
        payment.status === PaymentStatus.FAILED
          ? payment.providerMessage
          : withdrawal.failureReason;

      if (payment.status === PaymentStatus.SUCCEEDED) {
        if (wasAlreadyRefunded) {
          await this.settleSucceededAfterRefund(manager, withdrawal, payment);
        } else {
          await this.settleReservedWithdrawal(
            manager,
            withdrawal,
            true,
            payment,
          );
        }
        withdrawal.processedAt = payment.paidAt ?? new Date();
      } else if (
        [PaymentStatus.FAILED, PaymentStatus.CANCELLED].includes(payment.status)
      ) {
        await this.settleReservedWithdrawal(
          manager,
          withdrawal,
          false,
          payment,
        );
        withdrawal.processedAt = new Date();
      }
      return manager.save(withdrawal);
    });
  }

  private async failWithdrawal(
    withdrawalId: string,
    reason: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const withdrawal = await manager.findOne(ReferralWithdrawal, {
        where: { id: withdrawalId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !withdrawal ||
        [
          ReferralWithdrawalStatus.SUCCEEDED,
          ReferralWithdrawalStatus.FAILED,
          ReferralWithdrawalStatus.CANCELLED,
        ].includes(withdrawal.status)
      ) {
        return;
      }
      withdrawal.status = ReferralWithdrawalStatus.FAILED;
      withdrawal.failureReason = reason.slice(0, 500);
      withdrawal.processedAt = new Date();
      await this.settleReservedWithdrawal(manager, withdrawal, false, null);
      await manager.save(withdrawal);
    });
  }

  private async settleReservedWithdrawal(
    manager: EntityManager,
    withdrawal: ReferralWithdrawal,
    succeeded: boolean,
    payment: PaymentTransaction | null,
  ): Promise<void> {
    const tokens = Number(withdrawal.tokens);
    const account = await this.getOrCreateAccount(
      manager,
      withdrawal.userId,
      true,
    );
    account.reservedTokens = this.roundMoney(
      Number(account.reservedTokens) - tokens,
    );
    await manager.save(account);
    await this.createLedgerEntry(manager, account, {
      type: succeeded
        ? ReferralLedgerEntryType.WITHDRAWAL_SUCCEEDED
        : ReferralLedgerEntryType.WITHDRAWAL_REFUNDED,
      bucket: ReferralBalanceBucket.RESERVED,
      amountTokens: -tokens,
      balanceAfter: Number(account.reservedTokens),
      rewardId: null,
      withdrawalId: withdrawal.id,
      paymentTransactionId: payment?.id ?? withdrawal.paymentTransactionId,
      description: succeeded
        ? `Retrait FlexPay confirme ${withdrawal.id}`
        : `Réservation annulée pour le retrait ${withdrawal.id}`,
    });

    if (succeeded) {
      account.withdrawnTokens = this.roundMoney(
        Number(account.withdrawnTokens) + tokens,
      );
    } else {
      account.availableTokens = this.roundMoney(
        Number(account.availableTokens) + tokens,
      );
    }
    await manager.save(account);
    await this.createLedgerEntry(manager, account, {
      type: succeeded
        ? ReferralLedgerEntryType.WITHDRAWAL_SUCCEEDED
        : ReferralLedgerEntryType.WITHDRAWAL_REFUNDED,
      bucket: succeeded
        ? ReferralBalanceBucket.WITHDRAWN
        : ReferralBalanceBucket.AVAILABLE,
      amountTokens: tokens,
      balanceAfter: succeeded
        ? Number(account.withdrawnTokens)
        : Number(account.availableTokens),
      rewardId: null,
      withdrawalId: withdrawal.id,
      paymentTransactionId: payment?.id ?? withdrawal.paymentTransactionId,
      description: succeeded
        ? `Jetons payés par FlexPay pour le retrait ${withdrawal.id}`
        : `Jetons rendus disponibles après échec du retrait ${withdrawal.id}`,
    });
  }

  private async settleSucceededAfterRefund(
    manager: EntityManager,
    withdrawal: ReferralWithdrawal,
    payment: PaymentTransaction,
  ): Promise<void> {
    const tokens = Number(withdrawal.tokens);
    const account = await this.getOrCreateAccount(
      manager,
      withdrawal.userId,
      true,
    );
    account.availableTokens = this.roundMoney(
      Number(account.availableTokens) - tokens,
    );
    await manager.save(account);
    await this.createLedgerEntry(manager, account, {
      type: ReferralLedgerEntryType.WITHDRAWAL_SUCCEEDED,
      bucket: ReferralBalanceBucket.AVAILABLE,
      amountTokens: -tokens,
      balanceAfter: Number(account.availableTokens),
      rewardId: null,
      withdrawalId: withdrawal.id,
      paymentTransactionId: payment.id,
      description: `Correction après confirmation FlexPay tardive du retrait ${withdrawal.id}`,
    });

    account.withdrawnTokens = this.roundMoney(
      Number(account.withdrawnTokens) + tokens,
    );
    await manager.save(account);
    await this.createLedgerEntry(manager, account, {
      type: ReferralLedgerEntryType.WITHDRAWAL_SUCCEEDED,
      bucket: ReferralBalanceBucket.WITHDRAWN,
      amountTokens: tokens,
      balanceAfter: Number(account.withdrawnTokens),
      rewardId: null,
      withdrawalId: withdrawal.id,
      paymentTransactionId: payment.id,
      description: `Paiement FlexPay tardif confirmé pour le retrait ${withdrawal.id}`,
    });
  }

  private async ensureProfileAndAccount(userId: string): Promise<{
    profile: ReferralProfile;
    account: ReferralAccount;
  }> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockReferralUser(manager, userId);

      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) {
        throw new NotFoundException('Utilisateur introuvable');
      }
      let profile = await manager.findOne(ReferralProfile, {
        where: { userId },
      });
      if (!profile) {
        profile = await manager.save(
          manager.create(ReferralProfile, {
            userId,
            code: await this.generateUniqueCode(manager),
            linkToken: await this.generateUniqueLinkToken(manager),
            shareLinkUrl: null,
            shareLinkGeneratedAt: null,
            referredByUserId: null,
            referredAt: null,
            attributionProvider: null,
            attributionLinkToken: null,
            attributionReferringLink: null,
            attributionCapturedAt: null,
            qualifiedAt: null,
            rewardWindowEndsAt: null,
          }),
        );
      }
      const account = await this.getOrCreateAccount(manager, userId);
      return { profile, account };
    });
  }

  /**
   * Serializes profile/account creation and referral attribution for one user,
   * including the legacy case where no referral profile row exists yet.
   *
   * A transaction-scoped advisory lock is deliberately used instead of a
   * TypeORM relation lock: PostgreSQL rejects `FOR SHARE` on the nullable side
   * of the outer join generated by `relations: ['user']`.
   */
  private async lockReferralUser(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`zwanga:referral-user:${userId}`],
    );
  }

  private async getOrCreateAccount(
    manager: EntityManager,
    userId: string,
    lock = false,
  ): Promise<ReferralAccount> {
    let account = await manager.findOne(ReferralAccount, {
      where: { userId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!account) {
      account = await manager.save(
        manager.create(ReferralAccount, {
          userId,
          pendingTokens: 0,
          availableTokens: 0,
          reservedTokens: 0,
          withdrawnTokens: 0,
          currency: this.getTokensCurrency(),
        }),
      );
    }
    return account;
  }

  private async createLedgerEntry(
    manager: EntityManager,
    account: ReferralAccount,
    input: Omit<
      ReferralLedgerEntry,
      | 'id'
      | 'account'
      | 'accountId'
      | 'userId'
      | 'reward'
      | 'withdrawal'
      | 'paymentTransaction'
      | 'createdAt'
    >,
  ): Promise<ReferralLedgerEntry> {
    return manager.save(
      manager.create(ReferralLedgerEntry, {
        accountId: account.id,
        userId: account.userId,
        ...input,
      }),
    );
  }

  private async findUsableReferrerProfile(
    code: string,
  ): Promise<ReferralProfile> {
    const normalizedCode = this.normalizeCode(code);
    if (!normalizedCode) {
      throw new BadRequestException('Le code de parrainage est requis');
    }
    const profile = await this.profileRepository.findOne({
      where: { code: normalizedCode },
      relations: ['user'],
    });
    this.ensureReferrerIsUsable(profile);
    return profile!;
  }

  private async findUsableReferrerByToken(
    referralToken: string,
  ): Promise<ReferralProfile> {
    const normalizedToken = this.normalizeToken(referralToken);
    if (!normalizedToken) {
      throw new BadRequestException('Le lien de parrainage est invalide');
    }
    const profile = await this.profileRepository.findOne({
      where: { linkToken: normalizedToken },
      relations: ['user'],
    });
    this.ensureReferrerIsUsable(profile);
    return profile!;
  }

  private ensureReferrerIsUsable(profile: ReferralProfile | null): void {
    if (!profile || !this.isUserEligibleAsReferrer(profile.user)) {
      throw new BadRequestException('Code de parrainage invalide ou inactif');
    }
  }

  private isUserEligibleAsReferrer(user?: User | null): boolean {
    return Boolean(
      user?.isActive &&
      user.status !== UserStatus.SUSPENDED &&
      user.status !== UserStatus.INACTIVE,
    );
  }

  private async generateUniqueCode(manager: EntityManager): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = `ZW${randomBytes(5).toString('hex').toUpperCase()}`;
      const exists = await manager.exists(ReferralProfile, { where: { code } });
      if (!exists) {
        return code;
      }
    }
    throw new BadRequestException(
      'Impossible de générer un code de parrainage pour le moment',
    );
  }

  private async generateUniqueLinkToken(
    manager: EntityManager,
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = randomBytes(32).toString('base64url');
      const exists = await manager.exists(ReferralProfile, {
        where: { linkToken: token },
      });
      if (!exists) {
        return token;
      }
    }
    throw new BadRequestException(
      'Impossible de générer un lien de parrainage pour le moment',
    );
  }

  private normalizeCode(value?: string | null): string | null {
    const code = value?.trim().toUpperCase();
    return code || null;
  }

  private normalizeToken(value?: string | null): string | null {
    const token = value?.trim();
    if (!token) {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      throw new BadRequestException('Le lien de parrainage est invalide');
    }
    return token;
  }

  private resolveAttributionProvider(
    attribution: ReferralRegistrationAttribution,
  ): 'chottulink' | 'branch' {
    if (attribution.referralProvider) return attribution.referralProvider;
    const referringLink = attribution.referralReferringLink?.toLowerCase();
    return referringLink?.includes('.app.link') ? 'branch' : 'chottulink';
  }

  private validateAttributionCapturedAt(
    value: string | Date | null | undefined,
    referralToken: string | null,
  ): Date | null {
    if (!referralToken) {
      return null;
    }
    const capturedAt = value ? new Date(value) : new Date();
    if (Number.isNaN(capturedAt.getTime())) {
      throw new BadRequestException(
        'La date du lien de parrainage est invalide',
      );
    }
    const now = Date.now();
    const futureToleranceMs = 5 * 60 * 1000;
    const maxAgeMs = this.getAttributionDays() * 24 * 60 * 60 * 1000;
    if (
      capturedAt.getTime() > now + futureToleranceMs ||
      capturedAt.getTime() < now - maxAgeMs
    ) {
      throw new BadRequestException(
        `Ce lien de parrainage a expiré après ${this.getAttributionDays()} jours`,
      );
    }
    return capturedAt;
  }

  private getRewardRate(sourceType: ReferralRewardSourceType): number {
    if (sourceType === ReferralRewardSourceType.BOOKING_PAYMENT) {
      return this.getBookingRewardRate();
    }

    const rate = this.configRate(
      ['REFERRAL_SUBSCRIPTION_REWARD_RATE', 'REFERRAL_REWARD_RATE'],
      this.DEFAULT_SUBSCRIPTION_REWARD_RATE,
    );
    // Old runtime configuration must not keep paying the previous 5% share.
    return Math.min(rate, this.MAX_SUBSCRIPTION_REWARD_RATE);
  }

  private getBookingRewardRate(): number {
    const rate = this.configRate(
      ['REFERRAL_BOOKING_REWARD_RATE'],
      this.DEFAULT_BOOKING_REWARD_RATE,
    );
    const platformCommissionRate = this.getPlatformCommissionRate();
    const maxAllowedRate =
      platformCommissionRate > 0
        ? Math.min(this.MAX_BOOKING_REWARD_RATE, platformCommissionRate)
        : this.MAX_BOOKING_REWARD_RATE;
    if (rate > maxAllowedRate) {
      this.logger.warn(
        `REFERRAL_BOOKING_REWARD_RATE=${rate} exceeds the approved trip referral share ${maxAllowedRate} within ZWANGA_COMMISSION_RATE=${platformCommissionRate}; using ${maxAllowedRate}`,
      );
      return maxAllowedRate;
    }
    return rate;
  }

  private getPlatformCommissionRate(): number {
    return this.configRate(
      ['ZWANGA_COMMISSION_RATE'],
      this.DEFAULT_PLATFORM_COMMISSION_RATE,
    );
  }

  private configRate(keys: string[], fallback: number): number {
    let configured: string | number | undefined;
    for (const key of keys) {
      configured = this.configService.get<string | number>(key);
      if (configured !== undefined && configured !== null) {
        break;
      }
    }
    const rate = Number(configured ?? fallback);
    return Number.isFinite(rate) && rate > 0 && rate < 1 ? rate : fallback;
  }

  private getHoldDays(): number {
    return this.positiveConfig('REFERRAL_HOLD_DAYS', this.DEFAULT_HOLD_DAYS);
  }

  private getProgramMonths(): number {
    return this.positiveConfig(
      'REFERRAL_REWARD_WINDOW_MONTHS',
      this.DEFAULT_PROGRAM_MONTHS,
    );
  }

  private getMinimumWithdrawalTokens(): number {
    return REFERRAL_MIN_WITHDRAWAL_TOKENS;
  }

  private getAttributionDays(): number {
    return this.positiveConfig(
      'REFERRAL_ATTRIBUTION_DAYS',
      this.DEFAULT_ATTRIBUTION_DAYS,
    );
  }

  private getShareLinkRefreshDays(): number {
    return this.positiveConfig(
      'CHOTTULINK_LINK_REFRESH_DAYS',
      this.DEFAULT_SHARE_LINK_REFRESH_DAYS,
    );
  }

  private getTokensCurrency(): string {
    return (
      this.configService.get<string>('REFERRAL_TOKENS_CURRENCY')?.trim() ||
      'PTS'
    ).toUpperCase();
  }

  private getPayoutCurrency(): string {
    // The approved withdrawal threshold is denominated in Congolese francs.
    return 'CDF';
  }

  private getMoneyPerToken(currency: string): number {
    const normalizedCurrency = currency.toUpperCase();
    if (normalizedCurrency === 'CDF') return TOKEN_VALUE_CDF;
    const legacyCurrency = this.configService
      .get<string>('ZWANGA_POINT_VALUE_CURRENCY')
      ?.trim()
      .toUpperCase();
    const legacyGenericValue =
      legacyCurrency === normalizedCurrency
        ? this.configService.get<string | number>('ZWANGA_POINT_VALUE')
        : undefined;
    const configured =
      this.configService.get<string | number>(
        `REFERRAL_MONEY_PER_TOKEN_${normalizedCurrency}`,
      ) ??
      this.configService.get<string | number>(
        `ZWANGA_POINT_VALUE_${normalizedCurrency}`,
      ) ??
      legacyGenericValue;
    const value = Number(configured);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(
        `Valeur du jeton de parrainage non configurée pour ${normalizedCurrency}`,
      );
    }
    return value;
  }

  private positiveConfig(key: string, fallback: number): number {
    const value = Number(
      this.configService.get<string | number>(key) ?? fallback,
    );
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private normalizePositiveAmount(value: number): number {
    const amount = this.roundMoney(value);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Le montant est invalide');
    }
    return amount;
  }

  private roundMoney(value: number): number {
    return Math.round(Number(value) * 100) / 100;
  }

  private roundRate(value: number): number {
    return Math.round(Number(value) * 1_000_000) / 1_000_000;
  }

  private formatRate(rate: number): string {
    return `${this.roundMoney(rate * 100)} %`;
  }

  private addDays(value: Date, days: number): Date {
    return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private addMonths(value: Date, months: number): Date {
    const result = new Date(value);
    result.setUTCMonth(result.getUTCMonth() + months);
    return result;
  }

  private readShareLink(profile: ReferralProfile): string {
    const fallback = this.buildFallbackShareLink(profile.linkToken);
    const domain = this.configService.get<string>('CHOTTULINK_DOMAIN')?.trim();
    const valid = Boolean(domain && profile.shareLinkUrl && this.isExpectedChottuLinkUrl(profile.shareLinkUrl, domain));
    const fresh = valid && profile.shareLinkGeneratedAt &&
      Date.now() - new Date(profile.shareLinkGeneratedAt).getTime() < this.getShareLinkRefreshDays() * 86_400_000;
    if (!fresh && domain && this.configService.get<string>('CHOTTULINK_REST_API_KEY')?.trim() &&
        !this.shareLinkRefreshes.has(profile.id) && this.shareLinkRefreshes.size < 10 &&
        (this.shareLinkRefreshAfter.get(profile.id) ?? 0) <= Date.now()) {
      if (this.shareLinkRefreshAfter.size >= 1000)
        this.shareLinkRefreshAfter.delete(this.shareLinkRefreshAfter.keys().next().value!);
      this.shareLinkRefreshAfter.set(profile.id, Date.now() + 5 * 60_000);
      const work = this.getOrCreateChottuLinkShareLink(profile).then(() => undefined)
        .catch(() => { this.logger.warn('Referral share-link refresh deferred'); })
        .finally(() => { this.shareLinkRefreshes.delete(profile.id); });
      this.shareLinkRefreshes.set(profile.id, work);
    }
    return valid ? profile.shareLinkUrl! : fallback;
  }

  private async getOrCreateChottuLinkShareLink(
    profile: ReferralProfile,
  ): Promise<string> {
    const fallbackLink = this.buildFallbackShareLink(profile.linkToken);
    const restApiKey = this.configService
      .get<string>('CHOTTULINK_REST_API_KEY')
      ?.trim();
    const domain = this.configService.get<string>('CHOTTULINK_DOMAIN')?.trim();
    if (!restApiKey || !domain) {
      return fallbackLink;
    }

    const refreshAfterMs = this.getShareLinkRefreshDays() * 24 * 60 * 60 * 1000;
    if (
      profile.shareLinkUrl &&
      this.isExpectedChottuLinkUrl(profile.shareLinkUrl, domain) &&
      profile.shareLinkGeneratedAt &&
      Date.now() - profile.shareLinkGeneratedAt.getTime() < refreshAfterMs
    ) {
      return profile.shareLinkUrl;
    }

    const apiUrl =
      this.configService.get<string>('CHOTTULINK_API_URL')?.trim() ||
      'https://api2.chottulink.com/chotuCore/pa/v1/create-link';

    try {
      const response = await firstValueFrom(
        this.httpService.post<{ short_url?: string }>(
          apiUrl,
          {
            domain,
            destination_url: fallbackLink,
            link_name: `Parrainage Zwanga ${profile.code}`,
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
              'API-KEY': restApiKey,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      const shortUrl = response.data?.short_url?.trim();
      if (!shortUrl || !this.isExpectedChottuLinkUrl(shortUrl, domain)) {
        throw new Error('ChottuLink n’a pas retourné de lien HTTPS valide');
      }
      profile.shareLinkUrl = shortUrl;
      profile.shareLinkGeneratedAt = new Date();
      await this.profileRepository.update(profile.id, {
        shareLinkUrl: profile.shareLinkUrl, shareLinkGeneratedAt: profile.shareLinkGeneratedAt,
      });
      return shortUrl;
    } catch (error) {
      this.logger.warn(
        `ChottuLink referral link generation failed for profile=${profile.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return profile.shareLinkUrl || fallbackLink;
    }
  }

  private buildFallbackShareLink(linkToken: string): string {
    const base =
      this.configService.get<string>('REFERRAL_SHARE_BASE_URL')?.trim() ||
      'https://zwanga.app/register';
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}provider=chottulink&referralToken=${encodeURIComponent(linkToken)}`;
  }

  private isExpectedChottuLinkUrl(value: string, domain: string): boolean {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' &&
        parsed.hostname.toLowerCase() === domain.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  private mapPaymentStatus(status: PaymentStatus): ReferralWithdrawalStatus {
    switch (status) {
      case PaymentStatus.SUCCEEDED:
        return ReferralWithdrawalStatus.SUCCEEDED;
      case PaymentStatus.FAILED:
        return ReferralWithdrawalStatus.FAILED;
      case PaymentStatus.CANCELLED:
        return ReferralWithdrawalStatus.CANCELLED;
      case PaymentStatus.INITIATED:
        return ReferralWithdrawalStatus.INITIATED;
      default:
        return ReferralWithdrawalStatus.PENDING;
    }
  }

  private getWithdrawalCallbackUrl(): string {
    const explicit = this.configService
      .get<string>('FLEXPAY_REFERRAL_PAYOUT_CALLBACK_URL')
      ?.trim();
    if (explicit) {
      return explicit;
    }
    const base =
      this.configService.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_API_BASE_URL')?.trim();
    if (base) {
      return this.joinUrl(base, 'referrals/withdrawals/flexpay/callback');
    }
    const port = this.configService.get<string | number>('PORT') || 5200;
    const configuredHost =
      this.configService.get<string>('HOST')?.trim() || 'localhost';
    const host = configuredHost === '0.0.0.0' ? 'localhost' : configuredHost;
    const prefix =
      this.configService.get<string>('API_PREFIX')?.trim() || 'api/v1';
    return this.joinUrl(
      `http://${host}:${port}`,
      prefix,
      'referrals/withdrawals/flexpay/callback',
    );
  }

  private joinUrl(...parts: string[]): string {
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, ''),
      )
      .filter(Boolean)
      .join('/');
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === '23505',
    );
  }
}
