import { Module } from '@nestjs/common';
import { AppUpdatesController } from './app-updates.controller';
import { AppUpdatesService } from './app-updates.service';
import { AppUpdateDispatchService } from './app-update-dispatch.service';

@Module({ controllers: [AppUpdatesController], providers: [AppUpdatesService, AppUpdateDispatchService] })
export class AppUpdatesModule {}
