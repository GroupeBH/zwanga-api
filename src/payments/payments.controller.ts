import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Request,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { PaymentHistoryPageDto } from '../common/pagination/history-page';
import { PaymentContextDto } from './payment-context';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { FlexPayCallbackDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';
import { PawaPayService } from './pawapay.service';
import { PawaPayOperationsService } from './pawapay-operations.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly pawaPayService: PawaPayService,
    private readonly pawaPayOperations: PawaPayOperationsService,
  ) {}

  @Get('providers')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'List available payment providers and configured callback URLs',
  })
  getProviders() {
    return this.paymentsService.listPaymentProviders();
  }

  @Post('flexpay/callback')
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive a generic FlexPay payment callback' })
  async handleFlexPayCallback(@Body() dto: FlexPayCallbackDto) {
    return this.paymentsService.handleFlexPayCallback(dto);
  }

  @Post('pawapay/deposits/callback')
  @HttpCode(200)
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive a PawaPay deposit callback' })
  async handlePawaPayDepositCallback(
    @Req() request: RawBodyRequest<ExpressRequest>,
  ) {
    await this.pawaPayService.verifyCallbackRequest(request);
    return this.paymentsService.handlePawaPayCallback(
      'deposits',
      request.body ?? {},
    );
  }

  @Post('pawapay/payouts/callback')
  @HttpCode(200)
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive a PawaPay payout callback' })
  async handlePawaPayPayoutCallback(
    @Req() request: RawBodyRequest<ExpressRequest>,
  ) {
    await this.pawaPayService.verifyCallbackRequest(request);
    return this.paymentsService.handlePawaPayCallback(
      'payouts',
      request.body ?? {},
    );
  }

  @Post('pawapay/refunds/callback')
  @HttpCode(200)
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive a PawaPay refund callback' })
  async handlePawaPayRefundCallback(
    @Req() request: RawBodyRequest<ExpressRequest>,
  ) {
    await this.pawaPayService.verifyCallbackRequest(request);
    return this.pawaPayOperations.handleRefundCallback(request.body ?? {});
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

  @Get('history')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get sanitized payment history for the current user',
  })
  async getPaymentHistory(@Request() req) {
    const transactions = await this.paymentsService.findUserTransactions(
      req.user.userId,
    );

    return transactions.map((transaction) =>
      this.paymentsService.formatPaymentHistoryForClient(transaction),
    );
  }

  @Get('history/page')
  @Auth()
  @SensitiveThrottle(60, 60000)
  getPaymentHistoryPage(
    @Request() req,
    @Query() options: PaymentHistoryPageDto,
  ) {
    return this.paymentsService.findUserTransactionPage(
      req.user.userId,
      options,
    );
  }

  @Get('history/summary')
  @Auth()
  @SensitiveThrottle(30, 60000)
  getPaymentHistorySummary(@Request() req) {
    return this.paymentsService.getUserTransactionSummary(req.user.userId);
  }

  @Get('history/context')
  @Auth()
  @SensitiveThrottle(60, 60000)
  getPaymentContext(@Request() req, @Query() context: PaymentContextDto) {
    return this.paymentsService.findUserPaymentContext(
      req.user.userId,
      context,
    );
  }

  @Get(':paymentId/details')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get sanitized payment details for the current user',
  })
  async getPaymentDetails(
    @Request() req,
    @Param('paymentId') paymentId: string,
  ) {
    const transaction = await this.paymentsService.findTransactionById(
      paymentId,
      req.user.userId,
    );

    return this.paymentsService.formatPaymentHistoryForClient(transaction);
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
