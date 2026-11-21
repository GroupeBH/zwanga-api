import { Module } from '@nestjs/common';
import { AssetCreditController } from './asset-credit.controller';
import { AssetCreditService } from './asset-credit.service';
import { FinancingModule } from '../financing/financing.module';
@Module({
  imports: [FinancingModule],
  controllers: [AssetCreditController],
  providers: [AssetCreditService],
})
export class AssetCreditModule {}
