import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditPartnersController } from './credit-partners.controller';
import { CreditPartnersService } from './credit-partners.service';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditPartnersController],
  providers: [CreditPartnersService],
  exports: [CreditPartnersService],
})
export class CreditPartnersModule {}
