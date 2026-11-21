import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditFulfilmentController } from './credit-fulfilment.controller';
import { EquipmentStockModule } from './equipment-stock.module';
import { VehicleDocumentsModule } from './vehicle-documents.module';
import { CreditDeliveryService } from './credit-delivery.service';

@Module({
  imports: [CreditCoreModule, EquipmentStockModule, VehicleDocumentsModule],
  controllers: [CreditFulfilmentController],
  providers: [CreditDeliveryService],
  exports: [CreditDeliveryService],
})
export class CreditFulfilmentModule {}
