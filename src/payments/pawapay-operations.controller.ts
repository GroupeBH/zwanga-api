import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  PawaPayCreateRefundDto,
  PawaPayPredictProviderDto,
} from './dto/pawapay-operations.dto';
import { PawaPayOperationsService } from './pawapay-operations.service';
import { PawaPayService } from './pawapay.service';

@ApiTags('PawaPay')
@Controller('payments/pawapay')
export class PawaPayOperationsController {
  constructor(
    private readonly operations: PawaPayOperationsService,
    private readonly pawaPay: PawaPayService,
  ) {}

  @Get('methods')
  @Auth()
  @SensitiveThrottle(30, 60_000)
  @ApiOperation({
    summary: 'Get configured COD mobile money providers and payment limits',
  })
  async methods() {
    return this.operations.getSupportedMethods();
  }

  @Get('availability')
  @Auth()
  @SensitiveThrottle(30, 60_000)
  @ApiOperation({ summary: 'Get live COD provider availability' })
  async availability() {
    return this.operations.getAvailability();
  }

  @Post('predict-provider')
  @Auth()
  @SensitiveThrottle(20, 60_000)
  @ApiOperation({
    summary: 'Predict the COD mobile money provider for a phone number',
  })
  async predictProvider(@Body() dto: PawaPayPredictProviderDto) {
    return this.pawaPay.predictProvider(dto.phone);
  }

  @Get('wallet-balances')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60_000)
  @ApiOperation({ summary: 'Get pawaPay merchant wallet balances' })
  async walletBalances() {
    return this.pawaPay.getWalletBalances();
  }

  @Post('refunds')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(10, 60_000)
  @ApiOperation({
    summary:
      'Initiate an idempotent partial or full refund of a confirmed pawaPay deposit',
  })
  async createRefund(
    @Body() dto: PawaPayCreateRefundDto,
    @Request() req: { user: { userId: string } },
  ) {
    return this.operations.createRefund(dto, req.user.userId);
  }

  @Get('refunds/:refundId')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60_000)
  async getRefund(@Param('refundId', ParseUUIDPipe) refundId: string) {
    return this.operations.getRefund(refundId);
  }

  @Post('refunds/:refundId/check')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60_000)
  async checkRefund(@Param('refundId', ParseUUIDPipe) refundId: string) {
    return this.operations.checkRefund(refundId);
  }

  @Post('refunds/:refundId/retry')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(5, 60_000)
  @ApiOperation({
    summary:
      'Retry a refund with its original UUID only after pawaPay returns NOT_FOUND',
  })
  async retryRefund(@Param('refundId', ParseUUIDPipe) refundId: string) {
    return this.operations.retryRefund(refundId);
  }

  @Post('refunds/:refundId/resend-callback')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60_000)
  async resendRefundCallback(
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ) {
    return this.operations.resendRefundCallback(refundId);
  }

  @Post('refunds/:refundId/fail-enqueued')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(10, 60_000)
  async failEnqueuedRefund(@Param('refundId', ParseUUIDPipe) refundId: string) {
    return this.operations.failEnqueuedRefund(refundId);
  }

  @Get('transactions/:paymentId/refunds')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60_000)
  async listRefunds(@Param('paymentId', ParseUUIDPipe) paymentId: string) {
    return this.operations.listRefunds(paymentId);
  }

  @Post('transactions/:paymentId/check')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60_000)
  async checkPayment(@Param('paymentId', ParseUUIDPipe) paymentId: string) {
    return this.operations.checkPayment(paymentId);
  }

  @Post('transactions/:paymentId/resend-callback')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60_000)
  async resendPaymentCallback(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.operations.resendPaymentCallback(paymentId);
  }

  @Post('transactions/:paymentId/fail-enqueued')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(10, 60_000)
  async failEnqueuedPayout(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.operations.failEnqueuedPayout(paymentId);
  }
}
