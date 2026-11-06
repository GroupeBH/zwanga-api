import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FinanceAction, FinanceOtpService } from './finance-otp.service';

const KEY = 'finance-otp-action';
export const RequireFinanceOtp = (action: FinanceAction) =>
  applyDecorators(SetMetadata(KEY, action), UseGuards(FinanceOtpGuard));

@Injectable()
export class FinanceOtpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly finance: FinanceOtpService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const action = this.reflector.get<FinanceAction>(KEY, context.getHandler());
    if (!action) return true;
    const req = context.switchToHttp().getRequest();
    await this.finance.verify(
      req.user?.userId,
      action,
      req.body,
      req.params.id || req.params.withdrawalId,
    );
    // Never forward the secret into payout metadata, audit evidence or providers.
    delete req.body.otpCode;
    return true;
  }
}
