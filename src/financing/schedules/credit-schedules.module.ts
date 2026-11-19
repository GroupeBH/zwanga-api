import { Module } from '@nestjs/common';
import { CreditCoreModule } from '../shared/credit-shared.module';
import { CreditSchedulesController } from './credit-schedules.controller';
import { CreditSchedulesService } from './credit-schedules.service';
import { CreditRemindersWorker } from './credit-reminders.worker';

@Module({
  imports: [CreditCoreModule],
  controllers: [CreditSchedulesController],
  providers: [CreditSchedulesService, CreditRemindersWorker],
  exports: [CreditSchedulesService],
})
export class CreditSchedulesModule {}
