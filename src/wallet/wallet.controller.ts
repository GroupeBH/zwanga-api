import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import { InitiateWalletTopUpDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

@ApiTags('Wallet')
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('me')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current user points wallet' })
  async getMyWallet(@Request() req) {
    return this.walletService.getSummary(req.user.userId);
  }

  @Get('ledger')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current user points ledger' })
  async getMyLedger(@Request() req) {
    return this.walletService.getLedger(req.user.userId);
  }

  @Post('topups')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Buy Zwanga points through FlexPay' })
  async initiateTopUp(
    @Request() req,
    @Body() dto: InitiateWalletTopUpDto,
  ) {
    return this.walletService.initiateTopUp(req.user.userId, dto);
  }

  @Post('topups/flexpay/callback')
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive FlexPay callback for wallet topups' })
  async handleTopUpCallback(@Body() dto: FlexPayCallbackDto) {
    return this.walletService.handleTopUpCallback(dto);
  }

  @Get('topups/:orderNumber/status')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Check wallet topup payment status' })
  async checkTopUpStatus(
    @Request() req,
    @Param('orderNumber') orderNumber: string,
  ) {
    return this.walletService.checkTopUpPaymentStatus(
      req.user.userId,
      orderNumber,
    );
  }
}
