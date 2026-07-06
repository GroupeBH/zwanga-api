import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from '../common/common.module';
import { WeatherAwarenessService } from './weather-awareness.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 2,
    }),
    ConfigModule,
    CommonModule,
  ],
  providers: [WeatherAwarenessService],
  exports: [WeatherAwarenessService],
})
export class WeatherModule {}
