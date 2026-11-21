import { Module } from '@nestjs/common';
import { CreditStore } from './credit.store';

@Module({
  imports: [],
  controllers: [],
  providers: [CreditStore],
  exports: [CreditStore],
})
export class CreditCoreModule {}
