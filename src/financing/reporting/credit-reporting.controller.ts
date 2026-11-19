import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Request } from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditReportingService } from './credit-reporting.service';
import type { CreditActor } from '../shared/credit.store';

@ApiTags('Financing - reporting')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditReportingController {
  constructor(private readonly reporting: CreditReportingService) {}

  @Get('admin/overview') overview(@Request() req: { user: CreditActor }) {
    return this.reporting.overview(req.user);
  }
}
