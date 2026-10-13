import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KeccelOtpModule } from '../keccel-otp/keccel-otp.module';
import { OtpService } from './otp.service';

@Global()
@Module({
  imports: [ConfigModule, KeccelOtpModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
