import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { KeccelOtpModule } from '../keccel-otp/keccel-otp.module';
import { DiditOtpService } from './didit-otp.service';
import { OtpService } from './otp.service';

@Global()
@Module({
  imports: [HttpModule, ConfigModule, KeccelOtpModule],
  providers: [DiditOtpService, OtpService],
  exports: [OtpService],
})
export class OtpModule {}
