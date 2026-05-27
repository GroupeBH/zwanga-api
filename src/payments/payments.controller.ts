import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { FlexPayCallbackDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('flexpay/callback')
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive a generic FlexPay payment callback' })
  async handleFlexPayCallback(@Body() dto: FlexPayCallbackDto) {
    return this.paymentsService.handleFlexPayCallback(dto);
  }

  @Get('my-transactions')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get all payment transactions for the current user',
  })
  async getMyTransactions(@Request() req) {
    const transactions = await this.paymentsService.findUserTransactions(
      req.user.userId,
    );

    return transactions.map((transaction) =>
      this.paymentsService.formatPaymentForClient(transaction),
    );
  }

  @Get(':orderNumber/status')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Check a payment status for the current user' })
  async checkPaymentStatus(
    @Request() req,
    @Param('orderNumber') orderNumber: string,
  ) {
    const payment = await this.paymentsService.checkPaymentStatus(
      orderNumber,
      req.user.userId,
    );
    return this.paymentsService.formatPaymentForClient(payment);
  }
}
