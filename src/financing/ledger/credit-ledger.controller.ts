import { ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Request,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditLedgerService } from './credit-ledger.service';
import type { CreditActor } from '../shared/credit.store';
import { CreditPageDto } from '../shared/credit.dto';

@ApiTags('Financing - ledger')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditLedgerController {
  constructor(private readonly ledger: CreditLedgerService) {}

  @Get('mine/:id/receipts') receipts(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CreditPageDto,
  ) {
    return this.ledger.history(req.user, id, q);
  }

  @Get('admin/contracts/:id/receipts') adminReceipts(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CreditPageDto,
  ) {
    return this.ledger.history(req.user, id, q, true);
  }
}
