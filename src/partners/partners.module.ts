import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Trip } from '../trips/entities/trip.entity';
import { SupportModule } from '../support/support.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { PartnerFieldDailyReport, PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket, PartnerMember, PartnerOrganization } from './partner.entities';

@Module({
  imports: [TypeOrmModule.forFeature([PartnerOrganization, PartnerMember, PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket, PartnerFieldDailyReport, User, Trip]), SupportModule, ReferralsModule],
  controllers: [PartnersController],
  providers: [PartnersService],
})
export class PartnersModule {}
