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
import { CreditSchedulesService } from './credit-schedules.service';
import type { CreditActor } from '../shared/credit.store';
import {
  ConsentCreditScheduleDto,
  ProposeCreditScheduleDto,
} from './credit-schedules.dto';
import { CreditMutationDto } from '../shared/credit.dto';

@ApiTags('Financing - schedules')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditSchedulesController {
  constructor(private readonly schedules: CreditSchedulesService) {}

  @Post('reschedules/:id/consent') consentSchedule(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConsentCreditScheduleDto,
  ) {
    return this.schedules.reschedule(req.user, id, dto.mutationId, false);
  }

  @Post('admin/contracts/:id/reschedules') proposeSchedule(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProposeCreditScheduleDto,
  ) {
    return this.schedules.propose(req.user, id, dto);
  }

  @Post('admin/reschedules/:id/approve') approveSchedule(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditMutationDto,
  ) {
    return this.schedules.reschedule(req.user, id, dto.mutationId, true);
  }
}
