import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminPaymentReconciliationService } from './admin-payment-reconciliation.service';

@ApiTags('Admin')
@Controller('admin/payments')
@UseGuards(RolesGuard)
@Auth()
@Roles(UserRole.SUPER_ADMIN)
export class AdminPaymentsController {
  constructor(
    private readonly reconciliation: AdminPaymentReconciliationService,
  ) {}

  @Post(':paymentId/reconcile')
  @HttpCode(200)
  @SensitiveThrottle(10, 60_000)
  @ApiOperation({
    summary: 'Rapprocher une transaction existante sans réémission',
    description:
      'Vérifie le statut et applique le règlement métier idempotent. completed=false signifie résultat non confirmé, jamais un paiement réussi. Ne relance pas un retrait.',
  })
  reconcile(
    @Request() req: { user: { userId: string } },
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.reconciliation.reconcile(req.user.userId, paymentId);
  }
}
