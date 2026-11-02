import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminDirectPayoutService } from './admin-direct-payout.service';
import { AdminDirectPayoutDto } from './dto/admin-direct-payout.dto';

@ApiTags('Admin')
@Controller('admin/payments/direct-payouts')
@UseGuards(RolesGuard)
@Auth()
@Roles(UserRole.SUPER_ADMIN)
export class AdminDirectPayoutController {
  constructor(private readonly service: AdminDirectPayoutService) {}

  @Post()
  @HttpCode(200)
  @SensitiveThrottle(3, 60_000)
  @ApiOperation({
    summary:
      'Envoyer des fonds Zwanga via FlexPay, sans débiter un utilisateur',
    description:
      'Conserver le même idempotencyKey après un résultat incertain. Ne remplace ni ne clôture un retrait existant.',
  })
  create(
    @Request() req: { user: { userId: string } },
    @Body() dto: AdminDirectPayoutDto,
  ) {
    return this.service.create(req.user.userId, dto);
  }

  @Get(':idempotencyKey')
  @SensitiveThrottle(30, 60_000)
  @ApiOperation({
    summary: 'Retrouver son ordre administratif sans nouvel envoi',
  })
  get(
    @Request() req: { user: { userId: string } },
    @Param('idempotencyKey', new ParseUUIDPipe({ version: '4' })) key: string,
  ) {
    return this.service.get(req.user.userId, key);
  }
}
