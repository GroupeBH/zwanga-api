import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KeccelOtpModule } from '../keccel-otp/keccel-otp.module';
import { OtpService } from './otp.service';
import { HttpModule } from '@nestjs/axios';
import { MobishastraSmsService } from './mobishastra-sms.service';
import { MobishastraOtpService } from './mobishastra-otp.service';

@Global()
@Module({
  imports: [ConfigModule, KeccelOtpModule, HttpModule],
  providers: [OtpService, MobishastraSmsService, MobishastraOtpService],
  exports: [OtpService],
})
export class OtpModule {}
