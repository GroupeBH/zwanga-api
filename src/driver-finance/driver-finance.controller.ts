import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { DriverFinanceService } from './driver-finance.service';

type AuthenticatedRequest = { user: { userId: string } };

@ApiTags('Driver finance')
@Controller('driver-finance')
@Auth()
export class DriverFinanceController {
  constructor(private readonly finance: DriverFinanceService) {}
  @Get('me')
  summary(@Request() req: AuthenticatedRequest) {
    return this.finance.summary(req.user.userId);
  }
  @Get('trips/:id/payment-options')
  tripOptions(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('numberOfSeats') seats?: string,
  ) {
    return this.finance.tripOptions(
      req.user.userId,
      id,
      seats === undefined ? 1 : Number(seats),
    );
  }
  @Get('bookings/:id/payment-options')
  bookingOptions(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.finance.bookingOptions(req.user.userId, id);
  }
}
