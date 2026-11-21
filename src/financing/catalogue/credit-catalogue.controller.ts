import { ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Query,
  Request,
  Post,
  Body,
  Patch,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { CreditCatalogService } from './credit-catalogue.service';
import { CreditPageDto } from '../shared/credit.dto';
import type { CreditActor } from '../shared/credit.store';
import {
  CreateCreditProductDto,
  SetCreditProductEnabledDto,
} from './credit-catalogue.dto';

@ApiTags('Financing - catalogue')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditCatalogueController {
  constructor(private readonly catalog: CreditCatalogService) {}

  @Get('catalogue') products(@Query() q: CreditPageDto) {
    return this.catalog.list(q);
  }

  @Get('admin/catalogue') adminProducts(
    @Request() req: { user: CreditActor },
    @Query() q: CreditPageDto,
  ) {
    return this.catalog.list(q, req.user);
  }

  @Get('admin/configuration') configuration(
    @Request() req: { user: CreditActor },
  ) {
    return this.catalog.configuration(req.user);
  }

  @Post('admin/products') product(
    @Request() req: { user: CreditActor },
    @Body() dto: CreateCreditProductDto,
  ) {
    return this.catalog.create(req.user, dto);
  }

  @Patch('admin/products/:id') enabled(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCreditProductEnabledDto,
  ) {
    return this.catalog.enable(req.user, id, dto.enabled);
  }
}
