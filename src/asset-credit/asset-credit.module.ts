import { Module } from '@nestjs/common';
import { AssetCreditController } from './asset-credit.controller';
import { AssetCreditService } from './asset-credit.service';
@Module({
  controllers: [AssetCreditController],
  providers: [AssetCreditService],
})
export class AssetCreditModule {}
