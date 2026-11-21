import { ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Post,
  Request,
  Body,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Patch,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../../common/decorators/sensitive-throttle.decorator';
import { EquipmentStockService } from './equipment-stock.service';
import { CreditDeliveryService } from './credit-delivery.service';
import type { CreditActor } from '../shared/credit.store';
import { RegisterEquipmentStockDto } from './equipment-stock.dto';
import { CreditPageDto } from '../shared/credit.dto';
import {
  DeliverCreditProductDto,
  UpdateCreditDeliveryDto,
} from './credit-delivery.dto';

@ApiTags('Financing - fulfilment')
@Controller('zwanga-pro')
@Auth()
@SensitiveThrottle(30, 60000)
export class CreditFulfilmentController {
  constructor(
    private readonly equipment: EquipmentStockService,
    private readonly delivery: CreditDeliveryService,
  ) {}

  @Post('admin/stock') stock(
    @Request() req: { user: CreditActor },
    @Body() dto: RegisterEquipmentStockDto,
  ) {
    return this.equipment.stock(req.user, dto);
  }

  @Get('admin/products/:id/stock') inventory(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CreditPageDto,
  ) {
    return this.equipment.inventory(req.user, id, q);
  }

  @Post('admin/contracts/:id/deliver') deliver(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverCreditProductDto,
  ) {
    return this.delivery.deliver(req.user, id, dto);
  }

  @Patch('admin/contracts/:id/execution') execution(
    @Request() req: { user: CreditActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCreditDeliveryDto,
  ) {
    return this.delivery.execution(req.user, id, dto);
  }
}
