import { ApiTags } from '@nestjs/swagger';
import { Controller, Post, Request, Body } from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditPoliciesService } from './credit-policies.service';
import type { CreditActor } from '../shared/credit.store';
import { CreateCreditPolicyDto } from './credit-policies.dto';

@ApiTags('Financing - policies')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditPoliciesController {
  constructor(private readonly policies: CreditPoliciesService) {}

  @Post('admin/policies') policy(
    @Request() req: { user: CreditActor },
    @Body() dto: CreateCreditPolicyDto,
  ) {
    return this.policies.policy(req.user, dto);
  }
}
