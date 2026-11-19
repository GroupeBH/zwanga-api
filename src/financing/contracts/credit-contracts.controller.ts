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
import { CreditContractsService } from './credit-contracts.service';
import type { CreditActor } from '../shared/credit.store';
import { CreditPageDto, CreditMutationDto } from '../shared/credit.dto';
import { AcceptCreditContractDto } from './credit-contracts.dto';

@ApiTags('Financing - contracts')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditContractsController {
  constructor(private readonly contractsService: CreditContractsService) {}

  @Get('mine') mine(
    @Request() req: { user: CreditActor },
    @Query() q: CreditPageDto,
  ) {
    return this.contractsService.list(req.user, q);
  }

  @Get('mine/:id') detail(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.contractsService.detail(req.user, id);
  }

  @Post('mine/:id/accept') accept(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptCreditContractDto,
  ) {
    return this.contractsService.accept(req.user.userId, id, dto);
  }

  @Post('mine/:id/revoke-mandate') revoke(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditMutationDto,
  ) {
    return this.contractsService.revoke(req.user.userId, id, dto.mutationId);
  }

  @Get('admin/contracts') contracts(
    @Request() req: { user: CreditActor },
    @Query() q: CreditPageDto,
  ) {
    return this.contractsService.list(req.user, q, true);
  }

  @Get('admin/contracts/:id') adminDetail(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.contractsService.detail(req.user, id, true);
  }

  @Post('admin/contracts/:id/activate') activate(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditMutationDto,
  ) {
    return this.contractsService.activate(req.user, id, dto.mutationId);
  }
}
