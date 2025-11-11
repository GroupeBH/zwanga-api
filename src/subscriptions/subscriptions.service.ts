import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Subscription, SubscriptionStatus, SubscriptionPlan } from './entities/subscription.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectRepository(Subscription)
    private subscriptionRepository: Repository<Subscription>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private configService: ConfigService,
  ) {}

  async createTrial(userId: string): Promise<Subscription> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
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

    return await this.subscriptionRepository.save(subscription);
  }

  async subscribe(userId: string, plan: SubscriptionPlan): Promise<Subscription> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
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

    return await this.subscriptionRepository.save(subscription);
  }

  async getActiveSubscription(userId: string): Promise<Subscription | null> {
    return this.subscriptionRepository.findOne({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });
  }

  async getUserSubscriptions(userId: string): Promise<Subscription[]> {
    return this.subscriptionRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async checkSubscriptionStatus(userId: string): Promise<boolean> {
    const subscription = await this.getActiveSubscription(userId);

    if (!subscription) {
      return false;
    }

    // Check if subscription has expired
    if (new Date() > subscription.endDate) {
      subscription.status = SubscriptionStatus.EXPIRED;
      await this.subscriptionRepository.save(subscription);
      return false;
    }

    return true;
  }
}

