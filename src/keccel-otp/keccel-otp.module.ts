import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { KeccelOtpService } from './keccel-otp.service';

@Global()
@Module({
  imports: [
    HttpModule.register({
      timeout: 30000, // 30 seconds
      maxRedirects: 5,
    }),
    ConfigModule,
  ],
  providers: [KeccelOtpService],
  exports: [KeccelOtpService],
})
export class KeccelOtpModule {}

