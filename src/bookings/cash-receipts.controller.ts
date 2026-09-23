import { Body, Controller, Param, ParseUUIDPipe, Put, Request } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNumber, Max, Min } from 'class-validator';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { CashReceiptsService } from './cash-receipts.service';

class ConfirmCashReceiptDto {
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(99999999.99)
  amount: number;

  @IsIn(['CDF', 'USD'])
  currency: string;
}

@ApiTags('Bookings')
@Controller('bookings')
export class CashReceiptsController {
  constructor(private readonly receipts: CashReceiptsService) {}

  @Put(':id/cash-receipt')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Confirmer explicitement le cash reçu après la dépose (conducteur du trajet uniquement)' })
  confirm(@Param('id', ParseUUIDPipe) id: string, @Request() req, @Body() dto: ConfirmCashReceiptDto) {
    return this.receipts.confirm(id, req.user.userId, dto.amount, dto.currency);
  }
}
