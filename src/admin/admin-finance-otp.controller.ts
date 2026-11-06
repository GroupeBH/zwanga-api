import { Body, Controller, HttpCode, Post, Request } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { FinanceOtpService } from '../otp/finance-otp.service';
import type { FinanceAction } from '../otp/finance-otp.service';

export class FinanceOtpRequestDto {
  @ApiProperty({
    enum: ['direct_payout', 'driver_payout_retry', 'referral_withdrawal_retry'],
  })
  @IsIn(['direct_payout', 'driver_payout_retry', 'referral_withdrawal_retry'])
  action: FinanceAction;
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetId?: string;
  @ApiProperty({
    description: 'Paramètres exacts du virement/de la relance, sans code OTP.',
  })
  @IsObject()
  payload: Record<string, unknown>;
}

@ApiTags('Admin')
@Controller('admin/finance/otp')
@Auth()
@Roles(UserRole.SUPER_ADMIN)
export class AdminFinanceOtpController {
  constructor(private readonly finance: FinanceOtpService) {}
  @Post()
  @HttpCode(200)
  @SensitiveThrottle(3, 60_000)
  send(
    @Request() req: { user: { userId: string } },
    @Body() dto: FinanceOtpRequestDto,
  ) {
    return this.finance.send(
      req.user.userId,
      dto.action,
      dto.payload,
      dto.targetId,
    );
  }
}
