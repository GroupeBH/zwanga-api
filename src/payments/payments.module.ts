import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentTransaction } from './entities/payment-transaction.entity';
import { FlexPayService } from './flexpay.service';
import { PawaPayService } from './pawapay.service';
import { PaymentSettlementRegistry } from './payment-settlement.registry';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([PaymentTransaction])],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    FlexPayService,
    PawaPayService,
    PaymentSettlementRegistry,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
