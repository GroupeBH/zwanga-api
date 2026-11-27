import { Controller, Get, Param, ParseUUIDPipe, Post, Request, UseInterceptors } from '@nestjs/common';
import { BookingResponseInterceptor } from './booking-response.interceptor';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { PaymentRequestService } from './payment-request.service';

@UseInterceptors(BookingResponseInterceptor)
@Controller('bookings')
export class PaymentRequestController {
  constructor(private readonly payments: PaymentRequestService) {}

  @Get(':id/payment-request')
  @Auth()
  read(@Param('id', ParseUUIDPipe) id: string, @Request() req: { user: { userId: string } }) {
    return this.payments.read(id, req.user.userId);
  }

  @Post(':id/payment-request')
  @Auth()
  @SensitiveThrottle(5, 60000)
  request(@Param('id', ParseUUIDPipe) id: string, @Request() req: { user: { userId: string } }) {
    return this.payments.request(id, req.user.userId);
  }
}
