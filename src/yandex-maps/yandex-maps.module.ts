import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { YandexMapsController } from './yandex-maps.controller';
import { YandexMapsService } from './yandex-maps.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    ConfigModule,
  ],
  controllers: [YandexMapsController],
  providers: [YandexMapsService],
  exports: [YandexMapsService],
})
export class YandexMapsModule {}
