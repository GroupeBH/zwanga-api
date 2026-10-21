import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, MoreThan, Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  Subscription,
  SubscriptionStatus,
  SubscriptionPlan,
} from './entities/subscription.entity';
import {
  AdministrativeDocumentType,
  DocumentFundingRequest,
  DocumentFundingRequestStatus,
} from './entities/document-funding-request.entity';
import {
  CreateDocumentFundingRequestDto,
  ListDocumentFundingRequestsQueryDto,
  SubscribeDto,
  SubscribeWithPointsDto,
  UpdateDocumentFundingRequestStatusDto,
} from './dto/subscription.dto';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { PaymentsService } from '../payments/payments.service';
import { User, UserRole } from '../users/entities/user.entity';
import { CacheService } from '../common/services/cache.service';
import { WalletLedgerEntry, WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';
import { ReferralsService } from '../referrals/referrals.service';
import { DRIVER_FINANCE } from '../driver-finance/driver-finance.policy';

export interface PremiumSubscriptionFeatures {
  isActive: boolean;
  isPremium: boolean;
  premiumBadgeEnabled: boolean;
  featuredTripsEnabled: boolean;
  documentFundingEnabled: boolean;
  documentFundingLimit: number | null;
  documentFundingCurrency: string;
  subscriptionId: string | null;
  plan: SubscriptionPlan | null;
  endDate: Date | null;
}

export interface SubscriptionPaymentResponse {
  subscription: Subscription;
  walletEntry?: WalletLedgerEntry | null;
  payment: {
    transactionId: string | null;
    method: PaymentMethod | null;
    reference: string | null;
    orderNumber: string | null;
    status: PaymentStatus | null;
    statusCode: string | null;
    message: string | null;
    paymentUrl: string | null;
    amount: number;
    currency: string;
  };
}

export type ProSubscriptionMonthFilter = 'current' | 'other';

/** Inclusive start and exclusive end of the Kinshasa calendar month containing `now`. */
export function kinshasaCalendarMonth(now = new Date()): { from: Date; to: Date } {
  const [yearText, monthText] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kinshasa',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    from: new Date(`${yearText}-${monthText}-01T00:00:00+01:00`),
    to: new Date(
      `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+01:00`,
    ),
  };
}

export function parseProSubscriptionMonth(
  value?: string | null,
): ProSubscriptionMonthFilter | undefined {
  const month = value?.trim() ?? '';
  if (month === '' || month === 'all') return undefined;
  if (month === 'current' || month === 'other') return month;
  throw new BadRequestException(
    'Le filtre de mois doit être current, other ou all.',
  );
}

export interface FlexPayCallbackResponse {
  received: boolean;
  verified: boolean;
  subscriptionId: string;
  status: SubscriptionStatus;
  paymentTransactionId: string | null;
  paymentStatus: PaymentStatus | null;
  paymentStatusCode: string | null;
  message: string | null;
}

@Injectable()
export class SubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly DEFAULT_SUBSCRIPTION_CURRENCY = 'USD';
  private readonly DEFAULT_DOCUMENT_FUNDING_CURRENCY = 'CDF';

  constructor(
    @InjectRepository(Subscription)
    private subscriptionRepository: Repository<Subscription>,
    @InjectRepository(DocumentFundingRequest)
    private documentFundingRequestRepository: Repository<DocumentFundingRequest>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private configService: ConfigService,
    private cacheService: CacheService,
    private paymentsService: PaymentsService,
    private walletService: WalletService,
    private referralsService: ReferralsService,
  ) {}

  onModuleInit() {
    this.paymentsService.registerSettlement?.(
      PaymentPurpose.SUBSCRIPTION_PRO,
      async (payment) => {
        const subscription = await this.findSubscriptionForPayment(payment);
        await this.applyPaymentToSubscription(subscription, payment);
      },
    );
  }

  async createTrial(userId: string): Promise<Subscription> {
    await this.getDriverUser(userId);
    // Kept for existing mobile clients. The first completed ride fixes the clock;
    // calling this endpoint cannot move it forward or renew an expired trial.
    const [first] = await this.subscriptionRepository.manager.query(`SELECT MIN(COALESCE(b."droppedOffAt", b."createdAt")) AS started
      FROM bookings b JOIN trips t ON t.id = b."tripId" WHERE t."driverId" = $1 AND b.status = 'completed'`, [userId]);
    if (!first?.started) throw new BadRequestException('Votre essai Pro de 30 jours démarre automatiquement à la fin de votre premier trajet conducteur.');
    const [claim] = await this.subscriptionRepository.manager.query('SELECT zwanga_start_driver_trial($1, $2) AS id', [userId, first.started]);
    if (!claim?.id) throw new BadRequestException('Cet essai a déjà été utilisé ou un abonnement Pro est déjà actif.');
    const savedSubscription = await this.subscriptionRepository.findOneByOrFail({ id: claim.id });
    await this.invalidatePremiumCaches();
    return savedSubscription;
  }

  getPlans() {
    const tokensAmount = this.getSubscriptionPointsPriceForPlans();
    const tokensCurrency = this.walletService.getPointsCurrency();

    return [
      {
        plan: SubscriptionPlan.PRO,
        durationDays: DRIVER_FINANCE.durationDays,
        trialDays: DRIVER_FINANCE.durationDays,
        commissionRate: DRIVER_FINANCE.commissionRate,
        cashCommissionRequiresPurchasedTokens: true,
        amount: this.getSubscriptionPrice(),
        currency: this.getSubscriptionCurrency(),
        premiumBadgeEnabled: true,
        featuredTripsEnabled: true,
        documentFundingEnabled: true,
        documentFundingLimit: this.getDocumentFundingLimit(),
        documentFundingCurrency: this.getDocumentFundingCurrency(),
        paymentMethods: [...Object.values(PaymentMethod), 'points'],
        pointsAmount: tokensAmount,
        pointsCurrency: tokensCurrency,
        tokensAmount,
        tokensCurrency,
        subscriptionRewardTokens:
          this.walletService.getSubscriptionPaymentRewardTokens(),
        eligibleDocumentTypes: Object.values(AdministrativeDocumentType),
      },
    ];
  }

  async subscribe(
    userId: string,
    dto: SubscribeDto,
  ): Promise<SubscriptionPaymentResponse> {
    this.logger.log(
      `Creating subscription payment for user: ${userId} - Plan: ${dto.plan}`,
    );

    const user = await this.getDriverUser(userId);
    if (dto.plan !== SubscriptionPlan.PRO) {
      throw new BadRequestException(
        'Le seul abonnement disponible est le pack pro',
      );
    }

    this.ensurePaymentMethodIsUsable(dto);

    const activeSubscription = await this.getActiveSubscription(user.id);
    if (activeSubscription) {
      const activePayment =
        await this.findPaymentForSubscription(activeSubscription);
      this.logger.log(
        `Subscription payment skipped because user already has an active subscription: userId=${user.id}, subscriptionId=${activeSubscription.id}`,
      );
      const response = this.buildPaymentResponse(
        activeSubscription,
        activePayment,
      );
      this.logSubscriptionPaymentResponse(
        'Subscription payment skipped active subscription',
        response,
      );
      return response;
    }

    const reusablePayment = await this.findReusablePendingSubscriptionPayment(
      user.id,
    );
    if (reusablePayment) {
      this.logger.log(
        `Reusing pending subscription payment: userId=${user.id}, subscriptionId=${reusablePayment.subscription.id}, paymentId=${reusablePayment.payment.id}, orderNumber=${reusablePayment.payment.orderNumber ?? 'none'}`,
      );
      const response = this.buildPaymentResponse(
        reusablePayment.subscription,
        reusablePayment.payment,
      );
      this.logSubscriptionPaymentResponse(
        'Subscription payment reused pending transaction',
        response,
      );
      return response;
    }

    await this.cancelPendingSubscriptions(user.id);

    const subscriptionPrice = this.getSubscriptionPrice();
    const startDate = new Date();
    const endDate = this.calculateEndDate(startDate);

    const subscription = this.subscriptionRepository.create({
      userId: user.id,
      plan: dto.plan,
      status: SubscriptionStatus.PENDING,
      startDate,
      endDate,
      amount: subscriptionPrice,
      currency: this.getSubscriptionCurrency(),
      premiumBadgeEnabled: true,
      featuredTripsEnabled: true,
      documentFundingEnabled: true,
      documentFundingLimit: this.getDocumentFundingLimit(),
      documentFundingCurrency: this.getDocumentFundingCurrency(),
      paymentReference: null,
      paymentTransactionId: null,
      isTrial: false,
    });

    let savedSubscription =
      await this.subscriptionRepository.save(subscription);
    let payment: PaymentTransaction;

    try {
      payment = await this.paymentsService.initiatePayment({
        userId: user.id,
        purpose: PaymentPurpose.SUBSCRIPTION_PRO,
        relatedEntityType: 'subscription',
        relatedEntityId: savedSubscription.id,
        method: dto.paymentMethod,
        phone: dto.phone,
        amount: subscriptionPrice,
        currency: this.getSubscriptionCurrency(),
        description: 'Abonnement Zwanga Pro',
        callbackUrl: this.getSubscriptionFlexPayCallbackUrl(),
        approveUrl: dto.approveUrl,
        cancelUrl: dto.cancelUrl,
        declineUrl: dto.declineUrl,
        referencePrefix: 'SUB',
        preferredProvider: dto.preferredProvider,
        pawaPayOperator: dto.pawaPayOperator,
      });
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      savedSubscription.status = SubscriptionStatus.PAYMENT_FAILED;
      await this.subscriptionRepository.save(savedSubscription);
      this.logger.error(
        `Subscription payment initiation failed: subscriptionId=${savedSubscription.id}, userId=${user.id}, method=${dto.paymentMethod}, message=${errorMessage}`,
        this.getErrorStack(error),
      );
      throw error;
    }

    savedSubscription.paymentReference = payment.reference;
    savedSubscription.paymentTransactionId = payment.id;
    savedSubscription =
      await this.subscriptionRepository.save(savedSubscription);

    this.logger.log(
      `Subscription payment initialized: ${savedSubscription.id} for user ${userId}, amount ${subscriptionPrice} ${savedSubscription.currency}, payment ${payment.id}`,
    );

    const response = this.buildPaymentResponse(savedSubscription, payment);
    this.logSubscriptionPaymentResponse(
      'Subscription payment initialized',
      response,
    );
    return response;
  }

  async subscribeWithPoints(
    userId: string,
    dto: SubscribeWithPointsDto,
  ): Promise<SubscriptionPaymentResponse> {
    this.logger.log(
      `Creating subscription with tokens for user: ${userId} - Plan: ${dto.plan}`,
    );

    const user = await this.getDriverUser(userId);
    if (dto.plan !== SubscriptionPlan.PRO) {
      throw new BadRequestException(
        'Le seul abonnement disponible est le pack pro',
      );
    }

    const pointsAmount = this.getSubscriptionPointsPrice();
    const result = await this.subscriptionRepository.manager.transaction(async manager => {
      // Same user-first order as paid activation. A retry observes the committed Pro.
      await manager.findOne(User, { where: { id: user.id }, lock: { mode: 'pessimistic_write' } });
      const active = await manager.findOne(Subscription, {
        where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
        order: { createdAt: 'DESC' }, lock: { mode: 'pessimistic_write' },
      });
      if (active && active.endDate > new Date()) {
        const walletEntry = await manager.findOne(WalletLedgerEntry, { where: {
          userId: user.id, type: WalletLedgerEntryType.SUBSCRIPTION_PAYMENT,
          relatedEntityType: 'subscription', relatedEntityId: active.id,
        } });
        return { subscription: active, walletEntry };
      }
      if (active) {
        active.status = SubscriptionStatus.EXPIRED;
        await manager.save(Subscription, active);
      }
      // Do not cancel a Mobile Money request which can still debit the user.
      const pendingPayment = await manager.findOne(PaymentTransaction, { where: {
        userId: user.id, purpose: PaymentPurpose.SUBSCRIPTION_PRO,
        status: In([PaymentStatus.PENDING, PaymentStatus.INITIATED]),
      } });
      if (pendingPayment) throw new BadRequestException('Un paiement Pro est déjà en cours. Vérifiez son statut avant de payer en jetons.');

      // Recover a pre-fix debit with its ORIGINAL amount; never silently charge it again.
      const pending = await manager.find(Subscription, {
        where: { userId: user.id, status: SubscriptionStatus.PENDING, currency: In(['PTS', 'POINTS']) },
        order: { createdAt: 'ASC' }, take: 21,
      });
      if (pending.length > 20) throw new BadRequestException('Vos anciens achats Pro nécessitent une vérification par le support.');
      let recovered: Subscription | undefined;
      for (const candidate of pending) {
        const debit = await manager.findOne(WalletLedgerEntry, { where: {
          userId: user.id, type: WalletLedgerEntryType.SUBSCRIPTION_PAYMENT,
          relatedEntityType: 'subscription', relatedEntityId: candidate.id,
        } });
        if (!debit) continue;
        if (recovered) throw new BadRequestException('Plusieurs achats Pro débités nécessitent une régularisation par le support.');
        recovered = candidate;
      }
      const startDate = new Date();
      const subscription = recovered ?? manager.create(Subscription, {
        userId: user.id,
        plan: dto.plan,
        status: SubscriptionStatus.PENDING,
        startDate,
        endDate: this.calculateEndDate(startDate),
        amount: pointsAmount,
        currency: this.walletService.getPointsCurrency(),
        premiumBadgeEnabled: true,
        featuredTripsEnabled: true,
        documentFundingEnabled: true,
        documentFundingLimit: this.getDocumentFundingLimit(),
        documentFundingCurrency: this.getDocumentFundingCurrency(),
        paymentReference: null,
        paymentTransactionId: null,
        isTrial: false,
      });
      const saved = await manager.save(Subscription, subscription);
      const walletEntry = await this.walletService.payForSubscription(saved, Number(saved.amount), manager);
      const activated = await this.activatePointsSubscription(saved, walletEntry, manager);
      return { subscription: activated, walletEntry };
    });
    // The money and entitlement are committed. Cache failures must not report a failed purchase.
    try { await this.invalidatePremiumCaches(); }
    catch { this.logger.warn('Pro activated; premium cache refresh will be retried on later reads'); }
    const response = result.walletEntry
      ? this.buildPointsPaymentResponse(result.subscription, result.walletEntry)
      : this.buildPaymentResponse(result.subscription, null);
    this.logSubscriptionPaymentResponse(
      'Subscription token payment completed',
      response,
    );
    return response;
  }

  async handleFlexPayCallback(
    dto: FlexPayCallbackDto,
  ): Promise<FlexPayCallbackResponse> {
    this.logger.log('Subscription FlexPay callback received');
    const payment = await this.paymentsService.handleFlexPayCallback(dto);
    const subscription = await this.findSubscriptionForPayment(payment);
    const savedSubscription = await this.applyPaymentToSubscription(
      subscription,
      payment,
    );
    this.logger.log(
      `Subscription callback applied: subscriptionId=${savedSubscription.id}, paymentId=${payment.id}, paymentStatus=${payment.status}, subscriptionStatus=${savedSubscription.status}`,
    );

    const response = this.buildCallbackResponse(
      savedSubscription,
      payment,
      payment.status === PaymentStatus.SUCCEEDED,
    );
    this.logger.log(
      `Subscription callback response: response=${this.paymentsService.formatLogPayload(response)}`,
    );
    return response;
  }

  async checkPaymentStatus(
    userId: string,
    orderNumber: string,
  ): Promise<SubscriptionPaymentResponse> {
    this.logger.log(
      `Subscription payment status check requested: userId=${userId}, orderNumber=${orderNumber}`,
    );
    const payment = await this.paymentsService.checkPaymentStatus(
      orderNumber,
      userId,
    );
    const subscription = await this.findSubscriptionForPayment(payment);
    const savedSubscription = await this.applyPaymentToSubscription(
      subscription,
      payment,
    );
    this.logger.log(
      `Subscription payment status check applied: subscriptionId=${savedSubscription.id}, paymentId=${payment.id}, paymentStatus=${payment.status}, subscriptionStatus=${savedSubscription.status}`,
    );

    const response = this.buildPaymentResponse(savedSubscription, payment);
    this.logSubscriptionPaymentResponse(
      'Subscription payment status check',
      response,
    );
    return response;
  }

  async getActiveSubscription(userId: string): Promise<Subscription | null> {
    this.logger.debug(`Fetching active subscription for user: ${userId}`);

    const subscription = await this.subscriptionRepository.findOne({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });

    if (!subscription) {
      this.logger.debug(`No active subscription found for user ${userId}`);
      return null;
    }

    if (new Date() > subscription.endDate) {
      subscription.status = SubscriptionStatus.EXPIRED;
      await this.subscriptionRepository.save(subscription);
      await this.invalidatePremiumCaches();
      this.logger.log(
        `Subscription ${subscription.id} expired for user ${userId}`,
      );
      return null;
    }

    this.logger.debug(
      `Active subscription found for user ${userId}: ${subscription.id}`,
    );
    return subscription;
  }

  async getUserSubscriptions(userId: string): Promise<Subscription[]> {
    this.logger.debug(`Fetching all subscriptions for user: ${userId}`);

    const subscriptions = await this.subscriptionRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(
      `Found ${subscriptions.length} subscriptions for user ${userId}`,
    );
    return subscriptions;
  }

  async checkSubscriptionStatus(userId: string): Promise<boolean> {
    this.logger.debug(`Checking subscription status for user: ${userId}`);
    return Boolean(await this.getActiveSubscription(userId));
  }

  async getPremiumOverview(
    userId: string,
  ): Promise<PremiumSubscriptionFeatures> {
    const subscription = await this.getActiveSubscription(userId);
    return this.buildPremiumFeatures(subscription);
  }

  async getPremiumFeaturesForUsers(
    userIds: string[],
  ): Promise<Map<string, PremiumSubscriptionFeatures>> {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    const map = new Map<string, PremiumSubscriptionFeatures>();

    for (const userId of uniqueUserIds) {
      map.set(userId, this.buildPremiumFeatures(null));
    }

    if (uniqueUserIds.length === 0) {
      return map;
    }

    const now = new Date();
    const subscriptions = await this.subscriptionRepository.find({
      where: {
        userId: In(uniqueUserIds),
        status: SubscriptionStatus.ACTIVE,
        endDate: MoreThan(now),
      },
      order: { createdAt: 'DESC' },
    });

    for (const subscription of subscriptions) {
      if (map.get(subscription.userId)?.isActive) {
        continue;
      }
      map.set(subscription.userId, this.buildPremiumFeatures(subscription));
    }

    return map;
  }

  async createDocumentFundingRequest(
    userId: string,
    dto: CreateDocumentFundingRequestDto,
  ): Promise<DocumentFundingRequest> {
    const user = await this.getDriverUser(userId);
    const subscription = await this.getActiveSubscription(user.id);

    if (!subscription?.documentFundingEnabled) {
      throw new BadRequestException(
        'Un abonnement premium actif est requis pour demander le financement de documents',
      );
    }

    if (
      dto.amountRequested !== undefined &&
      subscription.documentFundingLimit !== null &&
      Number(dto.amountRequested) > Number(subscription.documentFundingLimit)
    ) {
      throw new BadRequestException(
        `Le montant demandé dépasse le plafond de financement (${subscription.documentFundingLimit} ${subscription.documentFundingCurrency})`,
      );
    }

    const request = this.documentFundingRequestRepository.create({
      driverId: user.id,
      subscriptionId: subscription.id,
      documentType: dto.documentType,
      documentName: dto.documentName?.trim() || null,
      amountRequested: dto.amountRequested ?? null,
      currency:
        dto.currency?.trim().toUpperCase() ||
        subscription.documentFundingCurrency,
      description: dto.description?.trim() || null,
      status: DocumentFundingRequestStatus.PENDING,
      adminNote: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    });

    return this.documentFundingRequestRepository.save(request);
  }

  async getMyDocumentFundingRequests(
    userId: string,
  ): Promise<DocumentFundingRequest[]> {
    return this.documentFundingRequestRepository.find({
      where: { driverId: userId },
      relations: ['subscription'],
      order: { createdAt: 'DESC' },
    });
  }

  async listActiveProSubscriptions(
    page: number = 1,
    limit: number = 25,
    search?: string,
    month?: string,
  ) {
    const pageNumber = Math.max(Number(page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const query = this.subscriptionRepository
      .createQueryBuilder('subscription')
      .leftJoin('subscription.user', 'user')
      .addSelect([
        'user.id',
        'user.firstName',
        'user.lastName',
        'user.phone',
        'user.email',
      ])
      .where('subscription.plan = :plan', { plan: SubscriptionPlan.PRO })
      .andWhere('subscription.status = :status', { status: SubscriptionStatus.ACTIVE })
      .andWhere('subscription.endDate > :now', { now: new Date() });

    const monthFilter = parseProSubscriptionMonth(month);
    if (monthFilter) {
      const { from, to } = kinshasaCalendarMonth();
      query.andWhere(
        monthFilter === 'current'
          ? 'subscription.startDate >= :monthFrom AND subscription.startDate < :monthTo'
          : '(subscription.startDate < :monthFrom OR subscription.startDate >= :monthTo)',
        { monthFrom: from, monthTo: to },
      );
    }

    const term = search?.trim().slice(0, 160);
    if (term) {
      query.andWhere(
        `(
          user.firstName ILIKE :proSearch ESCAPE '!'
          OR user.lastName ILIKE :proSearch ESCAPE '!'
          OR concat(user.firstName, ' ', user.lastName) ILIKE :proSearch ESCAPE '!'
          OR concat(user.lastName, ' ', user.firstName) ILIKE :proSearch ESCAPE '!'
          OR user.phone ILIKE :proSearch ESCAPE '!'
          OR user.email ILIKE :proSearch ESCAPE '!'
        )`,
        { proSearch: `%${term.replace(/[!%_]/g, '!$&')}%` },
      );
    }

    const [subscriptions, total] = await query
      .orderBy('subscription.endDate', 'ASC')
      .addOrderBy('subscription.id', 'ASC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      subscriptions: subscriptions.map((subscription) =>
        this.serializeActiveProSubscription(subscription),
      ),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async getDocumentFundingRequests(
    query: ListDocumentFundingRequestsQueryDto,
  ): Promise<DocumentFundingRequest[]> {
    return this.documentFundingRequestRepository.find({
      where: query.status ? { status: query.status } : {},
      relations: ['driver', 'subscription'],
      order: { createdAt: 'DESC' },
    });
  }

  async updateDocumentFundingRequestStatus(
    requestId: string,
    adminId: string,
    dto: UpdateDocumentFundingRequestStatusDto,
  ): Promise<DocumentFundingRequest> {
    const request = await this.documentFundingRequestRepository.findOne({
      where: { id: requestId },
      relations: ['driver', 'subscription'],
    });

    if (!request) {
      throw new NotFoundException('Demande de financement introuvable');
    }

    request.status = dto.status;
    request.adminNote = dto.adminNote?.trim() || null;
    request.reviewedAt = new Date();
    request.reviewedByAdminId = adminId;

    return this.documentFundingRequestRepository.save(request);
  }

  private serializeActiveProSubscription(subscription: Subscription) {
    const user = subscription.user;
    return {
      id: subscription.id,
      userId: subscription.userId,
      plan: subscription.plan,
      status: subscription.status,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      amount: Number(subscription.amount),
      currency: subscription.currency,
      isTrial: subscription.isTrial,
      user: user
        ? {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            phone: user.phone ?? null,
            email: user.email ?? null,
          }
        : null,
    };
  }

  private ensurePaymentMethodIsUsable(dto: SubscribeDto): void {
    if (
      dto.paymentMethod === PaymentMethod.MOBILE_MONEY &&
      !dto.phone?.trim()
    ) {
      throw new BadRequestException(
        'Le numéro de téléphone est requis pour payer par Mobile Money',
      );
    }

    if (dto.paymentMethod === PaymentMethod.MOBILE_MONEY) {
      const normalizedPhone = dto.phone?.trim().replace(/[\s()-]/g, '');
      if (!normalizedPhone || !/^\+243\d{9}$/.test(normalizedPhone)) {
        throw new BadRequestException(
          'Le numéro Mobile Money doit commencer par +243, par exemple +243891234567',
        );
      }
    }

    if (
      dto.paymentMethod !== PaymentMethod.MOBILE_MONEY &&
      dto.paymentMethod !== PaymentMethod.CARD
    ) {
      throw new BadRequestException('Méthode de paiement non prise en charge');
    }
  }

  private async findReusablePendingSubscriptionPayment(
    userId: string,
  ): Promise<{
    subscription: Subscription;
    payment: PaymentTransaction;
  } | null> {
    const pendingSubscriptions = await this.subscriptionRepository.find({
      where: { userId, status: SubscriptionStatus.PENDING },
      relations: ['paymentTransaction'],
      order: { createdAt: 'DESC' },
    });

    for (const subscription of pendingSubscriptions) {
      const payment = await this.findPaymentForSubscription(subscription);
      if (!payment) {
        subscription.status = SubscriptionStatus.CANCELLED;
        await this.subscriptionRepository.save(subscription);
        continue;
      }

      if (payment.status === PaymentStatus.SUCCEEDED) {
        const activatedSubscription = await this.activatePaidSubscription(
          subscription,
          payment,
        );
        return { subscription: activatedSubscription, payment };
      }

      if (payment.status === PaymentStatus.FAILED) {
        subscription.status = SubscriptionStatus.PAYMENT_FAILED;
        await this.subscriptionRepository.save(subscription);
        continue;
      }

      if (payment.status === PaymentStatus.CANCELLED) {
        subscription.status = SubscriptionStatus.CANCELLED;
        await this.subscriptionRepository.save(subscription);
        continue;
      }

      if (this.isRecentPayment(payment)) {
        return { subscription, payment };
      }

      subscription.status = SubscriptionStatus.CANCELLED;
      await this.subscriptionRepository.save(subscription);
      this.logger.log(
        `Stale pending subscription cancelled before new payment: subscriptionId=${subscription.id}, paymentId=${payment.id}, userId=${userId}`,
      );
    }

    return null;
  }

  private async findPaymentForSubscription(
    subscription: Subscription,
  ): Promise<PaymentTransaction | null> {
    if (subscription.paymentTransaction) {
      return subscription.paymentTransaction;
    }

    if (!subscription.paymentTransactionId) {
      return null;
    }

    try {
      return await this.paymentsService.findTransactionById(
        subscription.paymentTransactionId,
        subscription.userId,
      );
    } catch (error) {
      this.logger.warn(
        `Subscription payment transaction missing: subscriptionId=${subscription.id}, paymentTransactionId=${subscription.paymentTransactionId}, message=${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }

  private async cancelPendingSubscriptions(userId: string): Promise<void> {
    await this.subscriptionRepository.update(
      { userId, status: SubscriptionStatus.PENDING },
      { status: SubscriptionStatus.CANCELLED },
    );
  }

  private isRecentPayment(payment: PaymentTransaction): boolean {
    const openStatuses = new Set<string>([
      PaymentStatus.PENDING,
      PaymentStatus.INITIATED,
    ]);

    if (!openStatuses.has(payment.status)) {
      return false;
    }

    const createdAtMs = new Date(payment.createdAt).getTime();
    return (
      Number.isFinite(createdAtMs) &&
      Date.now() - createdAtMs <= this.getPendingPaymentReuseWindowMs()
    );
  }

  private async findSubscriptionForPayment(
    payment: PaymentTransaction,
  ): Promise<Subscription> {
    if (String(payment.purpose) !== 'subscription_pro') {
      throw new BadRequestException(
        'Cette transaction ne correspond pas à un abonnement Pro',
      );
    }

    const subscription = await this.subscriptionRepository.findOne({
      where: [
        { paymentTransactionId: payment.id },
        { paymentReference: payment.reference },
        ...(payment.relatedEntityId ? [{ id: payment.relatedEntityId }] : []),
      ],
      order: { createdAt: 'DESC' },
    });

    if (subscription) {
      return subscription;
    }

    throw new NotFoundException('Abonnement lié au paiement introuvable');
  }

  private async applyPaymentToSubscription(
    subscription: Subscription,
    payment: PaymentTransaction,
  ): Promise<Subscription> {
    const alreadyActivatedForPayment =
      [SubscriptionStatus.ACTIVE, SubscriptionStatus.EXPIRED].includes(subscription.status) &&
      subscription.paymentTransactionId === payment.id;
    subscription.paymentReference = payment.reference;
    subscription.paymentTransactionId = payment.id;

    if (payment.status === PaymentStatus.SUCCEEDED) {
      if (alreadyActivatedForPayment) {
        await this.walletService.awardSubscriptionPaymentTokens(
          subscription,
          payment.id,
        );
        await this.referralsService.awardSubscriptionReward(
          subscription,
          payment,
        );
        return subscription;
      }
      return this.activatePaidSubscription(subscription, payment);
    }

    const savedSubscription = await this.subscriptionRepository.manager.transaction(async manager => {
      await manager.findOne(User, { where: { id: subscription.userId }, lock: { mode: 'pessimistic_write' } });
      const current = await manager.findOne(Subscription, { where: { id: subscription.id }, lock: { mode: 'pessimistic_write' } });
      if (!current) throw new NotFoundException('Abonnement introuvable');
      // A status request started before activation cannot undo that activation.
      if ([SubscriptionStatus.ACTIVE, SubscriptionStatus.EXPIRED].includes(current.status)) return current;
      current.paymentReference = payment.reference;
      current.paymentTransactionId = payment.id;
      if (payment.status === PaymentStatus.FAILED && current.status !== SubscriptionStatus.CANCELLED) {
        current.status = SubscriptionStatus.PAYMENT_FAILED;
      }
      if (payment.status === PaymentStatus.CANCELLED) current.status = SubscriptionStatus.CANCELLED;
      return manager.save(Subscription, current);
    });
    if (
      [SubscriptionStatus.PAYMENT_FAILED, SubscriptionStatus.CANCELLED].includes(savedSubscription.status) &&
      (payment.status === PaymentStatus.FAILED || payment.status === PaymentStatus.CANCELLED)
    ) {
      await this.referralsService.reverseSubscriptionReward(
        savedSubscription.id,
        `Paiement FlexPay ${payment.status}`,
      );
    }
    this.logger.log(
      `Subscription payment state saved: subscriptionId=${savedSubscription.id}, paymentId=${payment.id}, paymentStatus=${payment.status}, subscriptionStatus=${savedSubscription.status}`,
    );
    return savedSubscription;
  }

  private async activatePaidSubscription(
    subscription: Subscription,
    payment: PaymentTransaction,
  ): Promise<Subscription> {
    const savedSubscription = await this.subscriptionRepository.manager.transaction(async manager => {
      // Serialize concurrent callback/status/reconciliation activations for this user.
      await manager.findOne(User, { where: { id: subscription.userId }, lock: { mode: 'pessimistic_write' } });
      const current = await manager.findOne(Subscription, { where: { id: subscription.id }, lock: { mode: 'pessimistic_write' } });
      if (!current) throw new NotFoundException('Abonnement introuvable');
      if (current.status === SubscriptionStatus.CANCELLED) {
        // A late paid, superseded purchase needs support/refund, not cancellation of the current Pro.
        throw new BadRequestException('Paiement reçu pour un abonnement annulé : régularisation nécessaire');
      }
      if (current.paymentTransactionId === payment.id &&
          [SubscriptionStatus.ACTIVE, SubscriptionStatus.EXPIRED].includes(current.status)) return current;
      await manager.update(Subscription, {
        userId: current.userId, status: SubscriptionStatus.ACTIVE, id: Not(current.id),
      }, { status: SubscriptionStatus.CANCELLED });
      const startDate = new Date();
      Object.assign(current, {
        status: SubscriptionStatus.ACTIVE, startDate, endDate: this.calculateEndDate(startDate),
        paymentReference: payment.reference, paymentTransactionId: payment.id,
        premiumBadgeEnabled: true, featuredTripsEnabled: true, documentFundingEnabled: true,
        documentFundingLimit: this.getDocumentFundingLimit(), documentFundingCurrency: this.getDocumentFundingCurrency(),
      });
      return manager.save(Subscription, current);
    });
    await this.walletService.awardSubscriptionPaymentTokens(
      savedSubscription,
      payment.id,
    );
    await this.referralsService.awardSubscriptionReward(
      savedSubscription,
      payment,
    );
    await this.invalidatePremiumCaches();

    this.logger.log(
      `Paid subscription activated: subscriptionId=${savedSubscription.id}, userId=${savedSubscription.userId}, paymentId=${payment.id}, reference=${payment.reference}, endDate=${savedSubscription.endDate.toISOString()}`,
    );

    return savedSubscription;
  }

  private async activatePointsSubscription(
    subscription: Subscription,
    walletEntry: WalletLedgerEntry,
    manager: EntityManager,
  ): Promise<Subscription> {
    await manager.update(Subscription,
      {
        userId: subscription.userId,
        status: SubscriptionStatus.ACTIVE,
        id: Not(subscription.id),
      },
      { status: SubscriptionStatus.CANCELLED },
    );

    const startDate = new Date();
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.startDate = startDate;
    subscription.endDate = this.calculateEndDate(startDate);
    subscription.paymentReference = `POINTS-${walletEntry.id}`;
    subscription.paymentTransactionId = null;
    subscription.premiumBadgeEnabled = true;
    subscription.featuredTripsEnabled = true;
    subscription.documentFundingEnabled = true;
    subscription.documentFundingLimit = this.getDocumentFundingLimit();
    subscription.documentFundingCurrency = this.getDocumentFundingCurrency();

    const savedSubscription =
      await manager.save(Subscription, subscription);
    await this.walletService.awardSubscriptionPaymentTokens(savedSubscription, undefined, manager);

    this.logger.log(
      `Token subscription activated: subscriptionId=${savedSubscription.id}, userId=${savedSubscription.userId}, walletEntryId=${walletEntry.id}, endDate=${savedSubscription.endDate.toISOString()}`,
    );

    return savedSubscription;
  }

  private buildPaymentResponse(
    subscription: Subscription,
    payment: PaymentTransaction | null,
  ): SubscriptionPaymentResponse {
    return {
      subscription,
      payment: {
        transactionId: payment?.id ?? subscription.paymentTransactionId,
        method: payment?.method ?? null,
        reference: payment?.reference ?? subscription.paymentReference,
        orderNumber: payment?.orderNumber ?? null,
        status: payment?.status ?? null,
        statusCode: payment?.providerStatusCode ?? null,
        message: this.paymentsService.getClientPaymentMessage(payment),
        paymentUrl: payment?.paymentUrl ?? null,
        amount: Number(payment?.amount ?? subscription.amount),
        currency: payment?.currency ?? subscription.currency,
      },
    };
  }

  private buildPointsPaymentResponse(
    subscription: Subscription,
    walletEntry: WalletLedgerEntry,
  ): SubscriptionPaymentResponse {
    return {
      subscription,
      walletEntry,
      payment: {
        transactionId: null,
        method: null,
        reference: subscription.paymentReference,
        orderNumber: null,
        status: PaymentStatus.SUCCEEDED,
        statusCode: null,
        message: 'Abonnement payé avec jetons Zwanga',
        paymentUrl: null,
        amount: Math.abs(Number(walletEntry.amount ?? subscription.amount)),
        currency: walletEntry.currency ?? subscription.currency,
      },
    };
  }

  private buildCallbackResponse(
    subscription: Subscription,
    payment: PaymentTransaction | null,
    verified: boolean,
  ): FlexPayCallbackResponse {
    return {
      received: true,
      verified,
      subscriptionId: subscription.id,
      status: subscription.status,
      paymentTransactionId: payment?.id ?? subscription.paymentTransactionId,
      paymentStatus: payment?.status ?? null,
      paymentStatusCode: payment?.providerStatusCode ?? null,
      message: this.paymentsService.getClientPaymentMessage(payment),
    };
  }

  private logSubscriptionPaymentResponse(
    step: string,
    response: SubscriptionPaymentResponse,
  ): void {
    this.logger.log(
      `${step}: response=${this.paymentsService.formatLogPayload({
        subscriptionId: response.subscription.id,
        subscriptionStatus: response.subscription.status,
        payment: response.payment,
      })}`,
    );
  }

  private getSubscriptionFlexPayCallbackUrl(): string {
    const explicitUrl = this.configService
      .get<string>('FLEXPAY_SUBSCRIPTION_CALLBACK_URL')
      ?.trim();
    if (explicitUrl) {
      return explicitUrl;
    }

    const configuredBaseUrl =
      this.configService.get<string>('FLEXPAY_CALLBACK_BASE_URL')?.trim() ||
      this.configService.get<string>('PUBLIC_API_BASE_URL')?.trim();

    if (configuredBaseUrl) {
      return this.joinUrl(configuredBaseUrl, 'subscriptions/flexpay/callback');
    }

    const port = this.configService.get<string | number>('PORT') || 5200;
    const configuredHost =
      this.configService.get<string>('HOST')?.trim() || 'localhost';
    const host = configuredHost === '0.0.0.0' ? 'localhost' : configuredHost;
    const apiPrefix =
      this.configService.get<string>('API_PREFIX')?.trim() || 'api/v1';

    return this.joinUrl(
      `http://${host}:${port}`,
      apiPrefix,
      'subscriptions/flexpay/callback',
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

  private async getDriverUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(
        `Subscription operation failed: User ${userId} not found`,
      );
      throw new NotFoundException('Utilisateur introuvable');
    }

    if (user.role !== UserRole.DRIVER) {
      throw new BadRequestException(
        'Les abonnements premium sont réservés aux conducteurs',
      );
    }

    return user;
  }

  private async ensureNoActiveSubscription(
    userId: string,
    errorMessage: string,
  ): Promise<void> {
    const activeSubscription = await this.getActiveSubscription(userId);
    if (activeSubscription) {
      this.logger.warn(
        `Subscription operation failed: User ${userId} already has active subscription`,
      );
      throw new BadRequestException(errorMessage);
    }
  }

  private getSubscriptionPrice(): number {
    return DRIVER_FINANCE.proPrice;
  }

  private getSubscriptionPointsPriceForPlans(): number | null {
    try {
      return this.getSubscriptionPointsPrice();
    } catch {
      return null;
    }
  }

  private getSubscriptionPointsPrice(): number {
    const subscriptionPrice = this.getSubscriptionPrice();
    const subscriptionCurrency = this.getSubscriptionCurrency();
    return this.walletService.convertMoneyToPoints(
      subscriptionPrice,
      subscriptionCurrency,
    );
  }

  private calculateEndDate(startDate: Date): Date {
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + DRIVER_FINANCE.durationDays);
    return endDate;
  }

  private getDocumentFundingLimit(): number {
    return this.getNumberConfig('SUBSCRIPTION_DOCUMENT_FUNDING_LIMIT', 50000);
  }

  private getPendingPaymentReuseWindowMs(): number {
    return this.getNumberConfig(
      'SUBSCRIPTION_PENDING_PAYMENT_REUSE_MS',
      30 * 60 * 1000,
    );
  }

  private getSubscriptionCurrency(): string {
    return DRIVER_FINANCE.currency;
  }

  private getDocumentFundingCurrency(): string {
    return (
      this.configService.get<string>(
        'SUBSCRIPTION_DOCUMENT_FUNDING_CURRENCY',
      ) || this.DEFAULT_DOCUMENT_FUNDING_CURRENCY
    ).toUpperCase();
  }

  private getNumberConfig(key: string, fallback: number): number {
    const rawValue = this.configService.get<string | number>(key);
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private getFirstNumberConfig(keys: string[], fallback: number): number {
    for (const key of keys) {
      const rawValue = this.configService.get<string | number>(key);
      const parsed = Number(rawValue);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return fallback;
  }

  private getOptionalFirstNumberConfig(keys: string[]): number | null {
    for (const key of keys) {
      const rawValue = this.configService.get<string | number>(key);
      const parsed = Number(rawValue);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return null;
  }

  private roundMoney(value: number): number {
    return Math.round(Number(value) * 100) / 100;
  }

  private buildPremiumFeatures(
    subscription: Subscription | null,
  ): PremiumSubscriptionFeatures {
    return {
      isActive: Boolean(subscription),
      isPremium: Boolean(
        subscription?.premiumBadgeEnabled || subscription?.featuredTripsEnabled,
      ),
      premiumBadgeEnabled: Boolean(subscription?.premiumBadgeEnabled),
      featuredTripsEnabled: Boolean(subscription?.featuredTripsEnabled),
      documentFundingEnabled: Boolean(subscription?.documentFundingEnabled),
      documentFundingLimit: subscription?.documentFundingLimit ?? null,
      documentFundingCurrency:
        subscription?.documentFundingCurrency ??
        this.getDocumentFundingCurrency(),
      subscriptionId: subscription?.id ?? null,
      plan: subscription?.plan ?? null,
      endDate: subscription?.endDate ?? null,
    };
  }

  private async invalidatePremiumCaches(): Promise<void> {
    await this.cacheService.del(CacheService.getTripsListKey());
    await this.cacheService.del(CacheService.getTripsListKey('all'));
    await this.cacheService.del(CacheService.getTripsListKey('allTrips'));
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getErrorStack(error: unknown): string | undefined {
    return error instanceof Error ? error.stack : undefined;
  }
}
