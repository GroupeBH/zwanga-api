import { ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Post,
  Request,
  Param,
  ParseUUIDPipe,
  Body,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditWalletPaymentsService } from './credit-wallet-payments.service';
import type { CreditActor } from '../shared/credit.store';
import { CreditWalletPaymentDto } from './credit-wallet-payments.dto';

@ApiTags('Financing - repayments')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditRepaymentsController {
  constructor(private readonly payments: CreditWalletPaymentsService) {}

  @Post('mine/:id/wallet-payments')
  @SensitiveThrottle(5, 60000)
  pay(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditWalletPaymentDto,
  ) {
    return this.payments.wallet(req.user.userId, id, dto);
  }
}
