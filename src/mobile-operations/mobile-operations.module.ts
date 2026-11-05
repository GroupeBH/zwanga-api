import { Module } from '@nestjs/common';
import { AppUpdatesModule } from '../app-updates/app-updates.module';
import { StoreManagementModule } from '../store-management/store-management.module';
import { MobileController } from './mobile.controller';
import { MobileAdminController } from './mobile-admin.controller';
import { MobileConfig } from './mobile.config';
import { MobileInstallationsService } from './mobile-installations.service';
import { MobilePoliciesService } from './mobile-policies.service';
import { MobileCampaignsService } from './mobile-campaigns.service';
import { MobileAnalyticsService } from './mobile-analytics.service';
import { MobileMaintenanceService } from './mobile-maintenance.service';

@Module({
  imports: [AppUpdatesModule, StoreManagementModule],
  controllers: [MobileController, MobileAdminController],
  providers: [
    MobileConfig,
    MobileInstallationsService,
    MobilePoliciesService,
    MobileCampaignsService,
    MobileAnalyticsService,
    MobileMaintenanceService,
  ],
})
export class MobileOperationsModule {}
