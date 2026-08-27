import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { RequestReferralWithdrawalDto } from './dto/referral.dto';
import { ReferralAccount } from './entities/referral-account.entity';
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
  payment: PaymentTransaction;
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
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);
  private readonly WITHDRAWAL_RELATED_ENTITY_TYPE = 'referral_withdrawal';
  private readonly DEFAULT_REWARD_RATE = 0.05;
  private readonly DEFAULT_HOLD_DAYS = 7;
  private readonly DEFAULT_PROGRAM_MONTHS = 12;
  private readonly DEFAULT_MIN_WITHDRAWAL_TOKENS = 50;
  private readonly DEFAULT_MONEY_PER_TOKEN_CDF = 100;
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
        'Les informations de parrainage ne correspondent pas au meme parrain',
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

  async attachAuthenticatedUser(
    userId: string,
    attribution: ReferralRegistrationAttribution,
  ) {
    await this.assertReferralAttribution(attribution);
    const result = await this.registerUserInternal(userId, attribution);
    await this.afterReferralAssignment(userId, result);

    if (!result.profile.referredByUserId || !result.referrer) {
      throw new BadRequestException(
        "L'attribution de parrainage n'a pas pu etre enregistree",
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

  private async registerUserInternal(
    userId: string,
    attribution: ReferralRegistrationAttribution = {},
  ): Promise<ReferralRegistrationResult> {
    const normalizedCode = this.normalizeCode(attribution.referralCode);
    const normalizedToken = this.normalizeToken(attribution.referralToken);
    const capturedAt = this.validateAttributionCapturedAt(
      attribution.referralCapturedAt,
      normalizedToken,
    );

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

      if (normalizedCode || normalizedToken) {
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
            'Les informations de parrainage ne correspondent pas au meme parrain',
          );
        }
        const referrerProfile = tokenProfile ?? codeProfile;
        const referrerUser = referrerProfile
          ? await manager.findOne(User, {
              where: { id: referrerProfile.userId },
            })
          : null;
        if (!referrerProfile || !this.isUserEligibleAsReferrer(referrerUser)) {
          throw new BadRequestException(
            'Code de parrainage invalide ou inactif',
          );
        }
        resolvedReferrer = {
          userId: referrerProfile.userId,
          firstName: referrerUser!.firstName,
          fcmToken: referrerUser!.fcmToken,
        };

        if (profile.referredByUserId) {
          if (profile.referredByUserId !== referrerProfile.userId) {
            throw new BadRequestException(
              'Le parrain d un compte deja inscrit ne peut pas etre modifie',
            );
          }
        } else {
          if (referrerProfile.userId === userId) {
            throw new BadRequestException(
              'Vous ne pouvez pas utiliser votre propre code de parrainage',
            );
          }
          profile.referredByUserId = referrerProfile.userId;
          profile.referredAt = new Date();
          profile.attributionProvider = normalizedToken
            ? this.resolveAttributionProvider(attribution)
            : 'legacy_code';
          profile.attributionLinkToken = normalizedToken;
          profile.attributionReferringLink =
            attribution.referralReferringLink?.trim().slice(0, 500) || null;
          profile.attributionCapturedAt = capturedAt ?? new Date();
          newlyAttached = true;
        }
      }

      profile = await manager.save(profile);
      await this.getOrCreateAccount(manager, userId);
      return {
        profile,
        newlyAttached,
        referrer: resolvedReferrer,
        referredFirstName: user.firstName,
      };
    });
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
        `${result.referredFirstName} a rejoint votre reseau de parrainage.`,
        {
          type: 'referral_new_referral',
          referredUserId: userId,
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
    await this.releaseMatureRewardsForUser(userId);
    const { profile, account } = await this.ensureProfileAndAccount(userId);
    const [referralCount, rewardCount, kycApproved] = await Promise.all([
      this.profileRepository.count({ where: { referredByUserId: userId } }),
      this.rewardRepository.count({ where: { referrerUserId: userId } }),
      this.kycRepository.exists({
        where: { userId, status: KycStatus.APPROVED },
      }),
    ]);
    const payoutCurrency = this.getPayoutCurrency();
    const payoutMoneyPerToken = this.getMoneyPerToken(payoutCurrency);
    const shareLink = await this.getOrCreateChottuLinkShareLink(profile);

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
        kycApproved,
        minimumTokens: this.getMinimumWithdrawalTokens(),
        moneyPerToken: payoutMoneyPerToken,
        currency: payoutCurrency,
      },
      rules: {
        rewardRate: this.getRewardRate(),
        eligiblePayments: ['subscription_flexpay', 'booking_flexpay'],
        holdDays: this.getHoldDays(),
        rewardWindowMonths: this.getProgramMonths(),
        rewardWindowStartsAt: 'first_eligible_successful_payment',
        promotionalTokensWithdrawable: false,
      },
    };
  }

  async getReferrals(userId: string) {
    await this.releaseMatureRewardsForUser(userId);
    const [profiles, rawEarnings] = await Promise.all([
      this.profileRepository.find({
        where: { referredByUserId: userId },
        relations: ['user'],
        order: { referredAt: 'DESC' },
      }),
      this.rewardRepository
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
        }>(),
    ]);
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

  async getRewards(userId: string) {
    await this.releaseMatureRewardsForUser(userId);
    const rewards = await this.rewardRepository.find({
      where: { referrerUserId: userId },
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

  async getWithdrawals(userId: string) {
    const withdrawals = await this.withdrawalRepository.find({
      where: { userId },
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
      paymentMessage: withdrawal.paymentTransaction
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

  async awardSubscriptionReward(
    subscription: Subscription,
    payment: PaymentTransaction,
  ): Promise<ReferralReward | null> {
    if (
      subscription.isTrial ||
      payment.status !== PaymentStatus.SUCCEEDED ||
      payment.provider !== PaymentProvider.FLEXPAY ||
      String(payment.purpose) !== String(PaymentPurpose.SUBSCRIPTION_PRO)
    ) {
      return null;
    }
    return this.awardReward({
      referredUserId: subscription.userId,
      sourceType: ReferralRewardSourceType.SUBSCRIPTION_PAYMENT,
      sourceEntityId: subscription.id,
      payment,
    });
  }

  async awardBookingReward(booking: Booking): Promise<ReferralReward | null> {
    if (
      booking.status !== BookingStatus.COMPLETED ||
      !booking.droppedOff ||
      booking.paymentMode !== TripPaymentMode.ELECTRONIC ||
      booking.paymentStatus !== BookingPaymentStatus.SUCCEEDED ||
      !booking.paymentTransactionId
    ) {
      return null;
    }
    const payment = await this.paymentRepository.findOne({
      where: { id: booking.paymentTransactionId },
    });
    if (
      !payment ||
      payment.status !== PaymentStatus.SUCCEEDED ||
      payment.provider !== PaymentProvider.FLEXPAY ||
      String(payment.purpose) !== String(PaymentPurpose.TRIP_BOOKING)
    ) {
      return null;
    }
    return this.awardReward({
      referredUserId: booking.passengerId,
      sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
      sourceEntityId: booking.id,
      payment,
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
    await this.releaseMatureRewardsForUser(userId);
    const tokens = this.normalizePositiveAmount(dto.tokens);
    if (tokens < this.getMinimumWithdrawalTokens()) {
      throw new BadRequestException(
        `Le retrait minimum est de ${this.getMinimumWithdrawalTokens()} jetons`,
      );
    }
    const kycApproved = await this.kycRepository.exists({
      where: { userId, status: KycStatus.APPROVED },
    });
    if (!kycApproved) {
      throw new BadRequestException(
        'Votre identite KYC doit etre approuvee avant tout retrait',
      );
    }
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    const phone = dto.phone?.trim() || user.phone;
    if (!phone) {
      throw new BadRequestException(
        'Un numero Mobile Money est requis pour le retrait',
      );
    }

    const currency = this.getPayoutCurrency();
    const moneyPerToken = this.getMoneyPerToken(currency);
    const amount = this.roundMoney(tokens * moneyPerToken);
    let withdrawal = await this.reserveWithdrawal({
      userId,
      tokens,
      amount,
      currency,
      moneyPerToken,
      phone,
    });

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
      await this.failWithdrawal(
        withdrawal.id,
        error instanceof Error ? error.message : String(error),
      );
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

  @Cron(CronExpression.EVERY_HOUR)
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
      await this.releaseRewardById(reward.id);
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

    const grossAmount = this.normalizePositiveAmount(
      Number(input.payment.amount),
    );
    const sourceCurrency = input.payment.currency.toUpperCase();
    const rate = this.getRewardRate();
    const rewardAmount = this.roundMoney(grossAmount * rate);
    const sourceMoneyPerToken = this.getMoneyPerToken(sourceCurrency);
    const rewardTokens = this.roundMoney(rewardAmount / sourceMoneyPerToken);
    if (rewardTokens <= 0) {
      return null;
    }
    const eventAt = input.payment.paidAt ?? new Date();

    try {
      return await this.dataSource.transaction(async (manager) => {
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
          paymentTransactionId: input.payment.id,
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
          paymentTransactionId: input.payment.id,
          description: `Commission de 5 % en attente pour ${input.sourceType} ${input.sourceEntityId}`,
        });
        this.logger.log(
          `Referral reward recorded: rewardId=${reward.id}, referrer=${reward.referrerUserId}, referred=${reward.referredUserId}, tokens=${rewardTokens}`,
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
    const rewards = await this.rewardRepository.find({
      select: { id: true },
      where: {
        referrerUserId: userId,
        status: ReferralRewardStatus.PENDING,
        holdUntil: LessThanOrEqual(new Date()),
      },
      take: 500,
    });
    for (const reward of rewards) {
      await this.releaseRewardById(reward.id);
    }
  }

  private async releaseRewardById(rewardId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
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
        description: `Commission disponible apres retenue de ${this.getHoldDays()} jours`,
      });
      reward.status = ReferralRewardStatus.AVAILABLE;
      reward.availableAt = new Date();
      await manager.save(reward);
    });
  }

  private async reserveWithdrawal(input: {
    userId: string;
    tokens: number;
    amount: number;
    currency: string;
    moneyPerToken: number;
    phone: string;
  }): Promise<ReferralWithdrawal> {
    return this.dataSource.transaction(async (manager) => {
      const account = await this.getOrCreateAccount(
        manager,
        input.userId,
        true,
      );
      if (Number(account.availableTokens) < input.tokens) {
        throw new BadRequestException(
          'Solde de jetons de parrainage insuffisant pour ce retrait',
        );
      }
      let withdrawal = manager.create(ReferralWithdrawal, {
        userId: input.userId,
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

      account.availableTokens = this.roundMoney(
        Number(account.availableTokens) - input.tokens,
      );
      await manager.save(account);
      await this.createLedgerEntry(manager, account, {
        type: ReferralLedgerEntryType.WITHDRAWAL_RESERVED,
        bucket: ReferralBalanceBucket.AVAILABLE,
        amountTokens: -input.tokens,
        balanceAfter: Number(account.availableTokens),
        rewardId: null,
        withdrawalId: withdrawal.id,
        paymentTransactionId: null,
        description: `Jetons reserves pour le retrait ${withdrawal.id}`,
      });

      account.reservedTokens = this.roundMoney(
        Number(account.reservedTokens) + input.tokens,
      );
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
      return withdrawal;
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
        'Cette transaction ne correspond pas a un retrait de parrainage',
      );
    }
    return this.dataSource.transaction(async (manager) => {
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
        : `Reservation annulee pour le retrait ${withdrawal.id}`,
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
        ? `Jetons payes par FlexPay pour le retrait ${withdrawal.id}`
        : `Jetons rendus disponibles apres echec du retrait ${withdrawal.id}`,
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
      description: `Correction apres confirmation FlexPay tardive du retrait ${withdrawal.id}`,
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
      description: `Paiement FlexPay tardif confirme pour le retrait ${withdrawal.id}`,
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
      'Impossible de generer un code de parrainage pour le moment',
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
      'Impossible de generer un lien de parrainage pour le moment',
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
        `Ce lien de parrainage a expire apres ${this.getAttributionDays()} jours`,
      );
    }
    return capturedAt;
  }

  private getRewardRate(): number {
    const rate = Number(
      this.configService.get<string | number>('REFERRAL_REWARD_RATE') ??
        this.DEFAULT_REWARD_RATE,
    );
    return Number.isFinite(rate) && rate > 0 && rate < 1
      ? rate
      : this.DEFAULT_REWARD_RATE;
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
    return this.positiveConfig(
      'REFERRAL_MIN_WITHDRAWAL_TOKENS',
      this.DEFAULT_MIN_WITHDRAWAL_TOKENS,
    );
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
    return (
      this.configService.get<string>('REFERRAL_PAYOUT_CURRENCY')?.trim() ||
      'CDF'
    ).toUpperCase();
  }

  private getMoneyPerToken(currency: string): number {
    const normalizedCurrency = currency.toUpperCase();
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
      legacyGenericValue ??
      (normalizedCurrency === 'CDF'
        ? this.DEFAULT_MONEY_PER_TOKEN_CDF
        : undefined);
    const value = Number(configured);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(
        `Valeur du jeton de parrainage non configuree pour ${normalizedCurrency}`,
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

  private addDays(value: Date, days: number): Date {
    return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private addMonths(value: Date, months: number): Date {
    const result = new Date(value);
    result.setUTCMonth(result.getUTCMonth() + months);
    return result;
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
        throw new Error('ChottuLink n a pas retourne de lien HTTPS valide');
      }
      profile.shareLinkUrl = shortUrl;
      profile.shareLinkGeneratedAt = new Date();
      await this.profileRepository.save(profile);
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
