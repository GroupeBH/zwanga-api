import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import {
  ApplyToFleetDto,
  FleetApplicationsQueryDto,
  FleetDirectoryDto,
  ReviewFleetApplicationDto,
} from './fleet-applications.dto';
import { FleetApplicationsService } from './fleet-applications.service';

@ApiTags('Fleet applications')
@Controller('partners')
@Auth()
@SensitiveThrottle(30, 60000)
export class FleetApplicationsController {
  constructor(private readonly applications: FleetApplicationsService) {}

  @Get('fleets/directory')
  directory(@Request() r, @Query() q: FleetDirectoryDto) {
    return this.applications.directory(r.user.userId, q);
  }

  @Get('fleet-applications/mine')
  @Header('Cache-Control', 'private, no-store')
  mine(@Request() r, @Query() q: FleetApplicationsQueryDto) {
    return this.applications.list(r.user.userId, null, q);
  }

  @Post('fleets/:org/applications')
  @SensitiveThrottle(5, 60000)
  apply(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Body() d: ApplyToFleetDto,
  ) {
    return this.applications.apply(r.user.userId, org, d);
  }

  @Post('fleet-applications/:id/withdraw')
  withdraw(@Request() r, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.withdraw(r.user.userId, id);
  }

  @Get('organizations/:org/fleet-applications')
  @Header('Cache-Control', 'private, no-store')
  list(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Query() q: FleetApplicationsQueryDto,
  ) {
    return this.applications.list(r.user.userId, org, q);
  }

  @Post('organizations/:org/fleet-applications/:id/review')
  review(
    @Request() r,
    @Param('org', ParseUUIDPipe) org: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: ReviewFleetApplicationDto,
  ) {
    return this.applications.review(r.user.userId, org, id, d);
  }
}
