import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { OtpModule } from './otp.module';
import { FinanceOtpService } from './finance-otp.service';
import { FinanceOtpGuard } from './finance-otp.guard';

@Module({
  imports: [OtpModule, TypeOrmModule.forFeature([User])],
  providers: [FinanceOtpService, FinanceOtpGuard],
  exports: [FinanceOtpService, FinanceOtpGuard],
})
export class FinanceOtpModule {}
