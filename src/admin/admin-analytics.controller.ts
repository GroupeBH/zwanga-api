import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import {
  AdminDateRangeDto,
  AdminOverviewDto,
  AdminPaymentStatsDto,
  AdminSearchDto,
} from '../common/pagination/admin-query';
import { UserRole } from '../users/entities/user.entity';
import { AdminAnalyticsService } from './admin-analytics.service';

@ApiTags('Admin Analytics')
@Controller('admin')
@Auth()
@Roles(UserRole.ADMIN)
@SensitiveThrottle(20, 60000)
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @Get('analytics/overview')
  @ApiOperation({
    summary:
      'Full database trip aggregates; UTC creation cohort, default 30 days, max 366; optional preceding equal-length period',
  })
  overview(@Query() query: AdminOverviewDto) {
    return this.analytics.overview(query);
  }

  @Get('payments/stats')
  @ApiOperation({
    summary:
      'Payment counts, amounts by currency, reported operators and pending payout age',
  })
  payments(@Query() query: AdminPaymentStatsDto) {
    return this.analytics.paymentStats(query);
  }

  @Get(['ratings/stats', 'evaluations/stats'])
  @ApiOperation({
    summary: 'Actual ratings, distribution, trip completion and driver ranking',
  })
  ratings(@Query() query: AdminDateRangeDto) {
    return this.analytics.ratingsStats(query);
  }

  @Get('promotions/stats')
  @ApiOperation({
    summary:
      'Driver activity and recorded referral/loyalty rewards; excludes demo promotion codes',
  })
  promotions(@Query() query: AdminDateRangeDto) {
    return this.analytics.promotionsStats(query);
  }

  @Get('search')
  @ApiOperation({
    summary:
      'Search phones, trip IDs, payment references and tickets; 10 safe projections per type with totals',
  })
  search(@Query() query: AdminSearchDto) {
    return this.analytics.search(query.q);
  }
}
