import { Controller, Get, Post, Body, Param, Request } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionPlan } from './entities/subscription.entity';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post('trial')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Start trial period' })
  async startTrial(@Request() req) {
    return this.subscriptionsService.createTrial(req.user.userId);
  }

  @Post('subscribe')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Subscribe to a plan' })
  async subscribe(@Request() req, @Body('plan') plan: SubscriptionPlan) {
    return this.subscriptionsService.subscribe(req.user.userId, plan);
  }

  @Get('my-subscription')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current active subscription' })
  async getActiveSubscription(@Request() req) {
    return this.subscriptionsService.getActiveSubscription(req.user.userId);
  }

  @Get('my-subscriptions')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get all subscriptions of the current user' })
  async getUserSubscriptions(@Request() req) {
    return this.subscriptionsService.getUserSubscriptions(req.user.userId);
  }

  @Get('status')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Check subscription status' })
  async checkStatus(@Request() req) {
    const isActive = await this.subscriptionsService.checkSubscriptionStatus(
      req.user.userId,
    );
    return { isActive };
  }
}

