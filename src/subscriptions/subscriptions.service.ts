import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Subscription, SubscriptionStatus, SubscriptionPlan } from './entities/subscription.entity';
import {
  AdministrativeDocumentType,
  DocumentFundingRequest,
  DocumentFundingRequestStatus,
} from './entities/document-funding-request.entity';
import {
  CreateDocumentFundingRequestDto,
  ListDocumentFundingRequestsQueryDto,
  UpdateDocumentFundingRequestStatusDto,
} from './dto/subscription.dto';
import { User, UserRole } from '../users/entities/user.entity';
import { CacheService } from '../common/services/cache.service';

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

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
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
  ) {}

  async createTrial(userId: string): Promise<Subscription> {
    this.logger.log(`Creating trial subscription for user: ${userId}`);

    const user = await this.getDriverUser(userId);
    await this.ensureNoActiveSubscription(userId, 'User already has an active subscription');

    const trialPeriodDays = this.configService.get<number>('TRIAL_PERIOD_DAYS') || 7;
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + trialPeriodDays);

    const subscription = this.subscriptionRepository.create({
      userId: user.id,
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      startDate,
      endDate,
      amount: 0,
      premiumBadgeEnabled: true,
      featuredTripsEnabled: true,
      documentFundingEnabled: false,
      documentFundingLimit: 0,
      documentFundingCurrency: this.getDocumentFundingCurrency(),
      isTrial: true,
    });

    const savedSubscription = await this.subscriptionRepository.save(subscription);
    await this.invalidatePremiumCaches();

    this.logger.log(`Trial subscription created successfully: ${savedSubscription.id} for user ${userId} (${trialPeriodDays} days)`);
    return savedSubscription;
  }

  getPlans() {
    return Object.values(SubscriptionPlan).map((plan) => ({
      plan,
      amount: this.getSubscriptionPrice(plan),
      currency: this.getDocumentFundingCurrency(),
      premiumBadgeEnabled: true,
      featuredTripsEnabled: true,
      documentFundingEnabled: true,
      documentFundingLimit: this.getDocumentFundingLimit(),
      eligibleDocumentTypes: Object.values(AdministrativeDocumentType),
    }));
  }

  async subscribe(userId: string, plan: SubscriptionPlan): Promise<Subscription> {
    this.logger.log(`Creating subscription for user: ${userId} - Plan: ${plan}`);

    const user = await this.getDriverUser(userId);

    // Cancel existing active subscription before creating the new paid period.
    await this.subscriptionRepository.update(
      { userId: user.id, status: SubscriptionStatus.ACTIVE },
      { status: SubscriptionStatus.CANCELLED },
    );

    const subscriptionPrice = this.getSubscriptionPrice(plan);
    const startDate = new Date();
    const endDate = this.calculateEndDate(startDate, plan);

    // Mock payment - in production, integrate with payment gateway.
    const paymentReference = `PAY-${Date.now()}-${userId.substring(0, 8)}`;

    const subscription = this.subscriptionRepository.create({
      userId: user.id,
      plan,
      status: SubscriptionStatus.ACTIVE,
      startDate,
      endDate,
      amount: subscriptionPrice,
      premiumBadgeEnabled: true,
      featuredTripsEnabled: true,
      documentFundingEnabled: true,
      documentFundingLimit: this.getDocumentFundingLimit(),
      documentFundingCurrency: this.getDocumentFundingCurrency(),
      paymentReference,
      isTrial: false,
    });

    const savedSubscription = await this.subscriptionRepository.save(subscription);
    await this.invalidatePremiumCaches();

    this.logger.log(`Subscription created successfully: ${savedSubscription.id} for user ${userId} - Plan: ${plan}, Amount: ${subscriptionPrice}, Payment Ref: ${paymentReference}`);
    return savedSubscription;
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
      this.logger.log(`Subscription ${subscription.id} expired for user ${userId}`);
      return null;
    }

    this.logger.debug(`Active subscription found for user ${userId}: ${subscription.id}`);
    return subscription;
  }

  async getUserSubscriptions(userId: string): Promise<Subscription[]> {
    this.logger.debug(`Fetching all subscriptions for user: ${userId}`);

    const subscriptions = await this.subscriptionRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(`Found ${subscriptions.length} subscriptions for user ${userId}`);
    return subscriptions;
  }

  async checkSubscriptionStatus(userId: string): Promise<boolean> {
    this.logger.debug(`Checking subscription status for user: ${userId}`);
    return Boolean(await this.getActiveSubscription(userId));
  }

  async getPremiumOverview(userId: string): Promise<PremiumSubscriptionFeatures> {
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
        `Le montant demande depasse le plafond de financement (${subscription.documentFundingLimit} ${subscription.documentFundingCurrency})`,
      );
    }

    const request = this.documentFundingRequestRepository.create({
      driverId: user.id,
      subscriptionId: subscription.id,
      documentType: dto.documentType,
      documentName: dto.documentName?.trim() || null,
      amountRequested: dto.amountRequested ?? null,
      currency: dto.currency?.trim().toUpperCase() || subscription.documentFundingCurrency,
      description: dto.description?.trim() || null,
      status: DocumentFundingRequestStatus.PENDING,
      adminNote: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    });

    return this.documentFundingRequestRepository.save(request);
  }

  async getMyDocumentFundingRequests(userId: string): Promise<DocumentFundingRequest[]> {
    return this.documentFundingRequestRepository.find({
      where: { driverId: userId },
      relations: ['subscription'],
      order: { createdAt: 'DESC' },
    });
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

  private async getDriverUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`Subscription operation failed: User ${userId} not found`);
      throw new NotFoundException('User not found');
    }

    if (!user.isDriver && user.role !== UserRole.DRIVER) {
      throw new BadRequestException(
        'Les abonnements premium sont reserves aux conducteurs',
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
      this.logger.warn(`Subscription operation failed: User ${userId} already has active subscription`);
      throw new BadRequestException(errorMessage);
    }
  }

  private getSubscriptionPrice(plan: SubscriptionPlan): number {
    const monthlyPrice = this.configService.get<number>('SUBSCRIPTION_PRICE') || 5000;
    if (plan === SubscriptionPlan.YEARLY) {
      return this.configService.get<number>('SUBSCRIPTION_YEARLY_PRICE') || monthlyPrice * 12;
    }
    return monthlyPrice;
  }

  private calculateEndDate(startDate: Date, plan: SubscriptionPlan): Date {
    const endDate = new Date(startDate);
    if (plan === SubscriptionPlan.YEARLY) {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }
    return endDate;
  }

  private getDocumentFundingLimit(): number {
    return this.configService.get<number>('SUBSCRIPTION_DOCUMENT_FUNDING_LIMIT') || 50000;
  }

  private getDocumentFundingCurrency(): string {
    return (
      this.configService.get<string>('SUBSCRIPTION_DOCUMENT_FUNDING_CURRENCY') ||
      this.DEFAULT_DOCUMENT_FUNDING_CURRENCY
    ).toUpperCase();
  }

  private buildPremiumFeatures(
    subscription: Subscription | null,
  ): PremiumSubscriptionFeatures {
    return {
      isActive: Boolean(subscription),
      isPremium: Boolean(subscription?.premiumBadgeEnabled || subscription?.featuredTripsEnabled),
      premiumBadgeEnabled: Boolean(subscription?.premiumBadgeEnabled),
      featuredTripsEnabled: Boolean(subscription?.featuredTripsEnabled),
      documentFundingEnabled: Boolean(subscription?.documentFundingEnabled),
      documentFundingLimit: subscription?.documentFundingLimit ?? null,
      documentFundingCurrency:
        subscription?.documentFundingCurrency ?? this.getDocumentFundingCurrency(),
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
}
