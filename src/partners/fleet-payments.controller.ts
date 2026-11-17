import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import {
  FleetPageDto,
  FleetPaymentDecisionDto,
  FleetPaymentDto,
} from './fleet-payments.dto';
import { FleetPaymentsService } from './fleet-payments.service';
@Controller('partners')
@Auth()
@SensitiveThrottle(30, 60000)
export class FleetPaymentsController {
  constructor(private readonly payments: FleetPaymentsService) {}
  @Get('fleet-assignments/history') mine(
    @Request() r,
    @Query() q: FleetPageDto,
  ) {
    return this.payments.assignments(r.user.userId, q);
  }
  @Get('organizations/:org/fleet-assignments') assignments(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Query() q: FleetPageDto,
  ) {
    return this.payments.assignments(r.user.userId, q, org);
  }
  @Get('fleet-assignments/:id/payments') history(
    @Request() r,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: FleetPageDto,
  ) {
    return this.payments.history(r.user.userId, id, q);
  }
  @Post('fleet-assignments/:id/payments') declare(
    @Request() r,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: FleetPaymentDto,
  ) {
    return this.payments.declare(r.user.userId, id, d);
  }
  @Get('organizations/:org/fleet-assignments/:id/payments') organizationHistory(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: FleetPageDto,
  ) {
    return this.payments.history(r.user.userId, id, q, org);
  }
  @Post('organizations/:org/fleet-assignments/:id/payments/:paymentId/decide')
  decide(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() d: FleetPaymentDecisionDto,
  ) {
    return this.payments.decide(r.user.userId, org, id, paymentId, d);
  }
}
