import { ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Request,
  Query,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditApplicationsService } from './credit-applications.service';
import type { CreditActor } from '../shared/credit.store';
import { CreditPageDto } from '../shared/credit.dto';
import {
  SubmitCreditApplicationDto,
  ReviewCreditApplicationDto,
} from './credit-applications.dto';

@ApiTags('Financing - applications')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditApplicationsController {
  constructor(
    private readonly applicationsService: CreditApplicationsService,
  ) {}

  @Get('applications') applications(
    @Request() req: { user: CreditActor },
    @Query() q: CreditPageDto,
  ) {
    return this.applicationsService.list(req.user, q, false);
  }

  @Get('applications/:id') application(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.applicationsService.application(req.user, id);
  }

  @Post('applications')
  @SensitiveThrottle(5, 60000)
  apply(
    @Request() req: { user: CreditActor },
    @Body() dto: SubmitCreditApplicationDto,
  ) {
    return this.applicationsService.apply(req.user.userId, dto);
  }

  @Get('admin/applications') adminApplications(
    @Request() req: { user: CreditActor },
    @Query() q: CreditPageDto,
  ) {
    return this.applicationsService.list(req.user, q, true);
  }

  @Get('admin/applications/:id') adminApplication(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.applicationsService.application(req.user, id, true);
  }

  @Post('admin/applications/:id/review') review(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewCreditApplicationDto,
  ) {
    return this.applicationsService.review(req.user, id, dto);
  }
}
