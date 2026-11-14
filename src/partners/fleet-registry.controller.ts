import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { FleetRegistryService } from './fleet-registry.service';
import {
  FleetAssignDto,
  FleetDecisionDto,
  FleetRegisterDto,
  FleetReviewDto,
  FleetStateDto,
} from './fleet-registry.dto';
@Controller('partners')
@Auth()
@SensitiveThrottle(30, 60000)
export class FleetRegistryController {
  constructor(private readonly fleet: FleetRegistryService) {}
  @Get('fleet-registry/review')
  @Roles(UserRole.ADMIN)
  pendingReview() {
    return this.fleet.pendingReview();
  }
  @Get('fleet-assignments/mine') mine(@Request() r) {
    return this.fleet.mine(r.user.userId);
  }
  @Post('fleet-assignments/:id/decide') decide(
    @Request() r,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: FleetDecisionDto,
  ) {
    return this.fleet.decide(
      r.user.userId,
      id,
      d.accept,
      d.paymentTermsConfirmed,
    );
  }
  @Get('organizations/:org/fleet-registry') list(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
  ) {
    return this.fleet.list(r.user.userId, org);
  }
  @Post('organizations/:org/fleet-registry') register(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Body() d: FleetRegisterDto,
  ) {
    return this.fleet.register(r.user.userId, org, d);
  }
  @Post('organizations/:org/fleet-registry/:id/assign') assign(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: FleetAssignDto,
  ) {
    return this.fleet.assign(r.user.userId, org, id, d);
  }
  @Post('organizations/:org/fleet-registry/:id/close') close(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.fleet.close(r.user.userId, org, id);
  }
  @Post('organizations/:org/fleet-registry/:id/state') state(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: FleetStateDto,
  ) {
    return this.fleet.state(r.user.userId, org, id, d.status);
  }
  @Post('fleet-registry/:id/review') @Roles(UserRole.ADMIN) review(
    @Request() r,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: FleetReviewDto,
  ) {
    return this.fleet.review(r.user.userId, id, d);
  }
}
