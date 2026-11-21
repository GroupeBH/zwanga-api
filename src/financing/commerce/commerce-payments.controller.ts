import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditActor } from '../shared/credit.store';
import { CommercePaymentsService } from './commerce-payments.service';
import { ChangePurchasePlanDto, EarlySettlementDto } from './commerce.dto';
@Auth()
@Controller('zwanga-pro/commerce/mine')
@SensitiveThrottle(10, 60000)
export class CommercePaymentsController {
  constructor(private readonly service: CommercePaymentsService) {}
  @Get(':id/settlement') quote(
    @Request() r: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.quote(r.user.userId, id);
  }
  @Post(':id/settlement') settle(
    @Request() r: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EarlySettlementDto,
  ) {
    return this.service.settle(r.user.userId, id, dto);
  }
  @Get(':id/plans') plans(
    @Request() r: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.plans(r.user.userId, id);
  }
  @Post(':id/plans') change(
    @Request() r: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangePurchasePlanDto,
  ) {
    return this.service.changePlan(r.user.userId, id, dto);
  }
}
