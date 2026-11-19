import { Module } from '@nestjs/common';
import { VehicleDocumentsService } from './vehicle-documents.service';

@Module({
  providers: [VehicleDocumentsService],
  exports: [VehicleDocumentsService],
})
export class VehicleDocumentsModule {}
