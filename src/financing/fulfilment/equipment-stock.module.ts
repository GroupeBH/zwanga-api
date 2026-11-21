import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { EquipmentStockService } from './equipment-stock.service';

@Module({
  imports: [CreditCoreModule],
  providers: [EquipmentStockService],
  exports: [EquipmentStockService],
})
export class EquipmentStockModule {}
