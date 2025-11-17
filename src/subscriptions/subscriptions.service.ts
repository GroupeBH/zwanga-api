import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Subscription, SubscriptionStatus, SubscriptionPlan } from './entities/subscription.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectRepository(Subscription)
    private subscriptionRepository: Repository<Subscription>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private configService: ConfigService,
  ) {}

  async createTrial(userId: string): Promise<Subscription> {
    this.logger.log(`Creating trial subscription for user: ${userId}`);
    
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`Trial creation failed: User ${userId} not found`);
      throw new NotFoundException('User not found');
    }

    // Check if user already has an active subscription
    const activeSubscription = await this.subscriptionRepository.findOne({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
      },
    });

    if (activeSubscription) {
      this.logger.warn(`Trial creation failed: User ${userId} already has active subscription`);
      throw new BadRequestException('User already has an active subscription');
    }

    const trialPeriodDays = this.configService.get<number>('TRIAL_PERIOD_DAYS') || 7;
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + trialPeriodDays);

    const subscription = this.subscriptionRepository.create({
      userId,
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      startDate,
      endDate,
      amount: 0,
      isTrial: true,
    });

    const savedSubscription = await this.subscriptionRepository.save(subscription);
    
    this.logger.log(`Trial subscription created successfully: ${savedSubscription.id} for user ${userId} (${trialPeriodDays} days)`);
    return savedSubscription;
  }

  async subscribe(userId: string, plan: SubscriptionPlan): Promise<Subscription> {
    this.logger.log(`Creating subscription for user: ${userId} - Plan: ${plan}`);
    
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`Subscription creation failed: User ${userId} not found`);
      throw new NotFoundException('User not found');
    }

    // Cancel existing active subscription
    await this.subscriptionRepository.update(
      { userId, status: SubscriptionStatus.ACTIVE },
      { status: SubscriptionStatus.CANCELLED },
    );

    const subscriptionPrice = this.configService.get<number>('SUBSCRIPTION_PRICE') || 5000;
    const startDate = new Date();
    const endDate = new Date();

    if (plan === SubscriptionPlan.MONTHLY) {
      endDate.setMonth(endDate.getMonth() + 1);
    } else {
      endDate.setFullYear(endDate.getFullYear() + 1);
    }

    // Mock payment - in production, integrate with payment gateway
    const paymentReference = `PAY-${Date.now()}-${userId.substring(0, 8)}`;

    const subscription = this.subscriptionRepository.create({
      userId,
      plan,
      status: SubscriptionStatus.ACTIVE,
      startDate,
      endDate,
      amount: subscriptionPrice,
      paymentReference,
      isTrial: false,
    });

    const savedSubscription = await this.subscriptionRepository.save(subscription);
    
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

    if (subscription) {
      this.logger.debug(`Active subscription found for user ${userId}: ${subscription.id}`);
    } else {
      this.logger.debug(`No active subscription found for user ${userId}`);
    }
    
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
    
    const subscription = await this.getActiveSubscription(userId);

    if (!subscription) {
      this.logger.debug(`No active subscription found for user: ${userId}`);
      return false;
    }

    // Check if subscription has expired
    if (new Date() > subscription.endDate) {
      subscription.status = SubscriptionStatus.EXPIRED;
      await this.subscriptionRepository.save(subscription);
      this.logger.log(`Subscription ${subscription.id} expired for user ${userId}`);
      return false;
    }

    this.logger.debug(`User ${userId} has active subscription until ${subscription.endDate}`);
    return true;
  }
}

