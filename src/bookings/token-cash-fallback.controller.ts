import { Controller, Param, ParseUUIDPipe, Post, Request, UseInterceptors } from '@nestjs/common';
import { BookingResponseInterceptor } from './booking-response.interceptor';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { TokenCashFallbackService } from './token-cash-fallback.service';

@UseInterceptors(BookingResponseInterceptor)
@Controller('bookings')
export class TokenCashFallbackController {
  constructor(private readonly service: TokenCashFallbackService) {}
  @Post(':id/token-cash-fallback')
  @Auth()
  @SensitiveThrottle(10, 60000)
  switchToCash(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.switchToCash(id, req.user.userId);
  }
}
