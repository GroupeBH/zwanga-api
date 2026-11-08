import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Trip } from '../trips/entities/trip.entity';
import { SupportModule } from '../support/support.module';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket, PartnerMember, PartnerOrganization } from './partner.entities';

@Module({
  imports: [TypeOrmModule.forFeature([PartnerOrganization, PartnerMember, PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket, User, Trip]), SupportModule],
  controllers: [PartnersController],
  providers: [PartnersService],
})
export class PartnersModule {}
