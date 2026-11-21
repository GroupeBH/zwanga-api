import { ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Request,
  Put,
  Param,
  ParseUUIDPipe,
  Body,
  Post,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditPartnersService } from './credit-partners.service';
import type { CreditActor } from '../shared/credit.store';
import { CreditPartyDto, CreditGrantDto } from './credit-partners.dto';

@ApiTags('Financing - partners')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditPartnersController {
  constructor(private readonly partners: CreditPartnersService) {}

  @Get('admin/access') access(@Request() req: { user: CreditActor }) {
    return this.partners.access(req.user);
  }

  @Put('admin/parties/:id') party(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditPartyDto,
  ) {
    return this.partners.party(req.user, id, dto);
  }

  @Post('admin/grants') grant(
    @Request() req: { user: CreditActor },
    @Body() dto: CreditGrantDto,
  ) {
    return this.partners.grant(req.user, dto);
  }
}
