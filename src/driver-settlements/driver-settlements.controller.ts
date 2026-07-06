import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { RequestDriverPayoutDto } from './dto/driver-settlement.dto';
import { DriverSettlementsService } from './driver-settlements.service';

@ApiTags('Driver Settlements')
@Controller('driver-settlements')
export class DriverSettlementsController {
  constructor(
    private readonly driverSettlementsService: DriverSettlementsService,
  ) {}

  @Get('me')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current driver settlement balance' })
  async getMySummary(@Request() req) {
    return this.driverSettlementsService.getSummary(req.user.userId);
  }

  @Get('earnings')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current driver earnings' })
  async getMyEarnings(@Request() req) {
    return this.driverSettlementsService.findDriverEarnings(req.user.userId);
  }

  @Get('payouts')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current driver payouts' })
  async getMyPayouts(@Request() req) {
    return this.driverSettlementsService.findDriverPayouts(req.user.userId);
  }

  @Post('payouts')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Request a FlexPay Mobile Money driver payout' })
  async requestPayout(
    @Request() req,
    @Body() dto: RequestDriverPayoutDto,
  ) {
    return this.driverSettlementsService.requestPayout(req.user.userId, dto);
  }

  @Post('payouts/flexpay/callback')
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive FlexPay callback for driver payouts' })
  async handlePayoutCallback(@Body() dto: FlexPayCallbackDto) {
    return this.driverSettlementsService.handlePayoutCallback(dto);
  }

  @Get('payouts/:orderNumber/status')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Check driver payout status' })
  async checkPayoutStatus(
    @Request() req,
    @Param('orderNumber') orderNumber: string,
  ) {
    return this.driverSettlementsService.checkPayoutStatus(
      req.user.userId,
      orderNumber,
    );
  }
}
