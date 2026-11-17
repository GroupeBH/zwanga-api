import { Module } from '@nestjs/common';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';
import { ZonesWorker } from './zones.worker';

@Module({
  controllers: [ZonesController],
  providers: [ZonesService, ZonesWorker],
})
export class ZonesModule {}
