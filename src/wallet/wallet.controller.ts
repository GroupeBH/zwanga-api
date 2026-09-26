import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { FlexPayCallbackDto } from '../payments/dto/payment.dto';
import {
  InitiateWalletTopUpDto,
  TransferWalletPointsDto,
  RequestWalletWithdrawalDto,
} from './dto/wallet.dto';
import { WalletService } from './wallet.service';
import { WalletWithdrawalsService } from './wallet-withdrawals.service';
import { HistoryPageDto } from '../common/pagination/history-page';

@ApiTags('Wallet')
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly withdrawals: WalletWithdrawalsService,
  ) {}

  @Post('withdrawals')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Withdraw purchased tokens to Mobile Money (KYC required)',
  })
  requestWithdrawal(@Request() req, @Body() dto: RequestWalletWithdrawalDto) {
    return this.withdrawals.request(req.user.userId, dto);
  }

  @Get('withdrawals')
  @Auth()
  @SensitiveThrottle(30, 60000)
  listWithdrawals(@Request() req) {
    return this.withdrawals.list(req.user.userId);
  }

  @Get('withdrawals/:id/status')
  @Auth()
  @SensitiveThrottle(20, 60000)
  withdrawalStatus(
    @Request() req,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.withdrawals.get(req.user.userId, id);
  }

  @Post('withdrawals/flexpay/callback')
  @Public()
  @SensitiveThrottle(120, 60000)
  withdrawalCallback(@Body() dto: FlexPayCallbackDto) {
    return this.withdrawals.callback(dto);
  }

  @Get('me')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current user Zwanga token wallet' })
  async getMyWallet(@Request() req) {
    return this.walletService.getSummary(req.user.userId);
  }

  @Get('ledger')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current user Zwanga token ledger' })
  async getMyLedger(@Request() req) {
    return this.walletService.getLedger(req.user.userId);
  }

  @Get('ledger/page')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get a cursor page of current user token ledger' })
  getMyLedgerPage(@Request() req, @Query() options: HistoryPageDto) {
    return this.walletService.getLedgerPage(req.user.userId, options);
  }

  @Post('topups')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Buy Zwanga tokens through FlexPay' })
  async initiateTopUp(@Request() req, @Body() dto: InitiateWalletTopUpDto) {
    return this.walletService.initiateTopUp(req.user.userId, dto);
  }

  @Post('transfers')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Share Zwanga tokens with another platform user' })
  async transferPoints(@Request() req, @Body() dto: TransferWalletPointsDto) {
    return this.walletService.transferPoints(req.user.userId, dto);
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
