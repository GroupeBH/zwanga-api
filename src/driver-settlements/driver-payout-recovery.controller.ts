import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { DriverPayoutRecoveryService } from './driver-payout-recovery.service';
import {
  ClosePayoutIncidentDto,
  PayoutRecoveryListDto,
  ReconcileDriverPayoutDto,
  RequestPayoutReviewDto,
  ResolveDriverPayoutDto,
} from './dto/driver-payout-recovery.dto';

type AuthenticatedRequest = { user: { userId: string } };

@ApiTags('Driver Payout Recovery')
@Controller('driver-settlements')
@Auth()
export class DriverPayoutRecoveryController {
  constructor(private readonly recovery: DriverPayoutRecoveryService) {}

  @Post('payouts/:id/review')
  @SensitiveThrottle(5, 60_000)
  @ApiOperation({
    summary: 'Signaler un retrait bloqué, sans annulation ni nouvel envoi',
  })
  review(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestPayoutReviewDto,
  ) {
    return this.recovery.requestReview(req.user.userId, id, dto.reason);
  }

  @Post('payouts/:id/refresh')
  @SensitiveThrottle(10, 60_000)
  @ApiOperation({
    summary: 'Vérifier un retrait par son ID Zwanga, même sans numéro FlexPay',
  })
  refresh(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.recovery.refresh(id, req.user.userId);
  }
}

@ApiTags('Admin Driver Payout Recovery')
@Controller('admin/driver-payouts')
@Auth()
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminDriverPayoutRecoveryController {
  constructor(private readonly recovery: DriverPayoutRecoveryService) {}

  @Get()
  @SensitiveThrottle(30, 60_000)
  list(@Query() query: PayoutRecoveryListDto) {
    return this.recovery.list(query);
  }

  @Get(':id')
  @SensitiveThrottle(30, 60_000)
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.recovery.detail(id);
  }

  @Post(':id/reconcile')
  @SensitiveThrottle(10, 60_000)
  reconcile(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReconcileDriverPayoutDto,
  ) {
    return this.recovery.refresh(
      id,
      undefined,
      dto.orderNumber,
      req.user.userId,
    );
  }

  @Post(':id/resolve-not-paid')
  @SensitiveThrottle(5, 60_000)
  @ApiOperation({
    summary:
      'Libérer les gains après confirmation définitive FlexPay de non-paiement (preuve obligatoire)',
  })
  resolve(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDriverPayoutDto,
  ) {
    return this.recovery.resolveNotPaid(req.user.userId, id, dto);
  }

  @Post(':id/close-late-success')
  @SensitiveThrottle(5, 60_000)
  close(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClosePayoutIncidentDto,
  ) {
    return this.recovery.closeLateSuccessIncident(req.user.userId, id, dto);
  }
}
