import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';
import { Vehicle } from './entities/vehicle.entity';
import { User } from '../users/entities/user.entity';
import { Trip } from '../trips/entities/trip.entity';
import { RecurringTripTemplate } from '../trips/entities/recurring-trip-template.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vehicle, User, Trip, RecurringTripTemplate]),
  ],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
