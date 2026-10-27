import { Module } from '@nestjs/common';
import { AppUpdatesController } from './app-updates.controller';
import { AppUpdatesService } from './app-updates.service';
import { AppUpdateDispatchService } from './app-update-dispatch.service';
import { InstallationUpdatesController } from './installation-updates.controller';
import { InstallationUpdatesService } from './installation-updates.service';
import { InstallationUpdateDispatchService } from './installation-update-dispatch.service';

@Module({ controllers: [AppUpdatesController, InstallationUpdatesController], providers: [AppUpdatesService, AppUpdateDispatchService, InstallationUpdatesService, InstallationUpdateDispatchService] })
export class AppUpdatesModule {}
