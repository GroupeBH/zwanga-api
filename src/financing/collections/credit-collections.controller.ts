import {
  Body,
  BadRequestException,
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
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import type { CreditActor } from '../shared/credit.store';
import { CreditCollectionsService } from './credit-collections.service';
import {
  DebtorsPageDto,
  RecoveryActionDto,
  RecoveryPageDto,
} from './credit-collections.dto';

const creditIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException('Identifiant de crédit invalide.'),
});

@ApiTags('Financing - collections')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditCollectionsController {
  constructor(private readonly collections: CreditCollectionsService) {}

  @Post('admin/credits/:id/recovery-actions')
  @Header('Cache-Control', 'no-store')
  record(
    @Request() req: { user: CreditActor },
    @Param('id', creditIdPipe) id: string,
    @Body() dto: RecoveryActionDto,
  ) {
    return this.collections.record(req.user, id, dto);
  }
  @Get('admin/credits/:id/recovery-actions')
  @Header('Cache-Control', 'no-store')
  history(
    @Request() req: { user: CreditActor },
    @Param('id', creditIdPipe) id: string,
    @Query() page: RecoveryPageDto,
  ) {
    return this.collections.history(req.user, id, page);
  }
  @Get('admin/collections/debtors')
  @Header('Cache-Control', 'no-store')
  debtors(
    @Request() req: { user: CreditActor },
    @Query() page: DebtorsPageDto,
  ) {
    return this.collections.debtors(req.user, page);
  }
}
