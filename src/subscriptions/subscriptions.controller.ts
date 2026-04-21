import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Request,
  Query,
  Put,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import {
  CreateDocumentFundingRequestDto,
  ListDocumentFundingRequestsQueryDto,
  SubscribeDto,
  UpdateDocumentFundingRequestStatusDto,
} from './dto/subscription.dto';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('plans')
  @Public()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'List premium subscription plans and benefits' })
  async getPlans() {
    return this.subscriptionsService.getPlans();
  }

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
  @ApiOperation({ summary: 'Initiate payment for a premium subscription' })
  async subscribe(@Request() req, @Body() dto: SubscribeDto) {
    return this.subscriptionsService.subscribe(req.user.userId, dto);
  }

  @Post('flexpay/callback')
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive FlexPay payment callback' })
  async handleFlexPayCallback(@Body() dto: FlexPayCallbackDto) {
    return this.subscriptionsService.handleFlexPayCallback(dto);
  }

  @Get('payments/:orderNumber/status')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({
    summary: 'Check FlexPay payment status and activate if paid',
  })
  async checkPaymentStatus(
    @Request() req,
    @Param('orderNumber') orderNumber: string,
  ) {
    return this.subscriptionsService.checkPaymentStatus(
      req.user.userId,
      orderNumber,
    );
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
    return this.subscriptionsService.getPremiumOverview(req.user.userId);
  }

  @Get('premium-overview')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get premium subscription benefits for the current driver',
  })
  async getPremiumOverview(@Request() req) {
    return this.subscriptionsService.getPremiumOverview(req.user.userId);
  }

  @Post('document-funding-requests')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary: 'Create a document funding request for a premium driver',
  })
  async createDocumentFundingRequest(
    @Request() req,
    @Body() dto: CreateDocumentFundingRequestDto,
  ) {
    return this.subscriptionsService.createDocumentFundingRequest(
      req.user.userId,
      dto,
    );
  }

  @Get('document-funding-requests/my')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get my document funding requests' })
  async getMyDocumentFundingRequests(@Request() req) {
    return this.subscriptionsService.getMyDocumentFundingRequests(
      req.user.userId,
    );
  }

  @Get('document-funding-requests')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List document funding requests (Admin)' })
  async getDocumentFundingRequests(
    @Query() query: ListDocumentFundingRequestsQueryDto,
  ) {
    return this.subscriptionsService.getDocumentFundingRequests(query);
  }

  @Put('document-funding-requests/:requestId/status')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Update a document funding request status (Admin)' })
  async updateDocumentFundingRequestStatus(
    @Request() req,
    @Param('requestId') requestId: string,
    @Body() dto: UpdateDocumentFundingRequestStatusDto,
  ) {
    return this.subscriptionsService.updateDocumentFundingRequestStatus(
      requestId,
      req.user.userId,
      dto,
    );
  }
}
