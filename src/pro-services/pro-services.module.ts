import { Module } from '@nestjs/common';
import { ProServicesController } from './pro-services.controller';
import { ProServiceStore } from './pro-service.store';
import { ProServiceWorkflow } from './pro-service.workflow';
import { ProServiceFinance } from './pro-service.finance';
import { ProServiceConfiguration } from './pro-service.configuration';

@Module({
  controllers: [ProServicesController],
  providers: [
    ProServiceStore,
    ProServiceWorkflow,
    ProServiceFinance,
    ProServiceConfiguration,
  ],
})
export class ProServicesModule {}
