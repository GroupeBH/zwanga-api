import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { STORE_ENTITIES } from './store.entities';
import { StoreConfig } from './store.config';
import { StoreAuth } from './store.auth';
import { StoreHttp } from './store.http';
import { StoreRepository } from './store.repository';
import { StoreWorker } from './store.worker';
import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { GooglePlayProvider } from './google-play.provider';
import { AppleStoreProvider } from './apple-store.provider';
import { StoreAccess, StorePermissionsGuard } from './store.permissions';
import { StoreOperationsController } from './store-operations.controller';
import { StoreOperationsService } from './store-operations.service';
import { StoreAlertsService } from './store-alerts.service';
import { StoreExportsService } from './store-exports.service';

@Module({
  imports: [TypeOrmModule.forFeature(STORE_ENTITIES)],
  controllers: [StoreController, StoreOperationsController],
  providers: [
    StoreConfig,
    StoreAuth,
    StoreHttp,
    StoreRepository,
    StoreWorker,
    StoreService,
    GooglePlayProvider,
    AppleStoreProvider,
    StoreAccess,
    StorePermissionsGuard,
    StoreOperationsService,
    StoreAlertsService,
    StoreExportsService,
  ],
})
export class StoreManagementModule {}
