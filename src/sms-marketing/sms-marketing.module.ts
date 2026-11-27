import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { SmsMarketingConfig } from './sms.config';
import { SmsRepository } from './sms.repository';
import { SmsAudienceService } from './sms.audience';
import { MobishastraMarketingTransport } from './mobishastra-marketing.transport';
import { SmsCampaignsService } from './sms.campaigns';
import { SmsDeliveryService } from './sms.delivery';
import { SmsOptOutsService } from './sms.opt-outs';
import {
  SmsMarketingController,
  SmsUnsubscribeController,
} from './sms.controller';
import { SmsTracePrivacy } from './sms.trace-privacy';

@Module({
  imports: [ConfigModule, HttpModule],
  controllers: [SmsMarketingController, SmsUnsubscribeController],
  providers: [
    SmsTracePrivacy,
    SmsMarketingConfig,
    SmsRepository,
    SmsAudienceService,
    MobishastraMarketingTransport,
    SmsCampaignsService,
    SmsDeliveryService,
    SmsOptOutsService,
  ],
})
export class SmsMarketingModule {}
