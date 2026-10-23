import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { MixedCashPaymentDto } from './dto/mixed-cash-payment.dto';
import { MixedCashPaymentService } from './mixed-cash-payment.service';

@Controller('bookings')
export class MixedCashPaymentController {
  constructor(private readonly payments: MixedCashPaymentService) {}

  @Post(':id/pay-tokens-cash')
  @Auth()
  @SensitiveThrottle(10, 60000)
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: { user: { userId: string } },
    @Body() dto: MixedCashPaymentDto,
  ) {
    return this.payments.pay(id, req.user.userId, dto);
  }
}
