import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentTransaction } from './entities/payment-transaction.entity';
import { PawaPayRefund } from './entities/pawapay-refund.entity';
import { FlexPayService } from './flexpay.service';
import { PawaPayService } from './pawapay.service';
import { PaymentSettlementRegistry } from './payment-settlement.registry';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PawaPayOperationsController } from './pawapay-operations.controller';
import { PawaPayOperationsService } from './pawapay-operations.service';

@Module({
  imports: [
    HttpModule,
    TypeOrmModule.forFeature([PaymentTransaction, PawaPayRefund]),
  ],
  controllers: [PaymentsController, PawaPayOperationsController],
  providers: [
    PaymentsService,
    FlexPayService,
    PawaPayService,
    PawaPayOperationsService,
    PaymentSettlementRegistry,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
