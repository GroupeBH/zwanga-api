import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Trip } from '../trips/entities/trip.entity';
import { SupportModule } from '../support/support.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { FleetRegistryController } from './fleet-registry.controller';
import { FleetRegistryService } from './fleet-registry.service';
import { FleetPaymentsService } from './fleet-payments.service';
import { FleetPaymentsController } from './fleet-payments.controller';
import { PartnerFieldDailyReport, PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket, PartnerMember, PartnerOrganization } from './partner.entities';

@Module({
  imports: [TypeOrmModule.forFeature([PartnerOrganization, PartnerMember, PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket, PartnerFieldDailyReport, User, Trip]), SupportModule, ReferralsModule],
  controllers: [PartnersController,FleetRegistryController,FleetPaymentsController],
  providers: [PartnersService,FleetRegistryService,FleetPaymentsService],
})
export class PartnersModule {}
