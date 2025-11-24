import { Module } from '@nestjs/common';
import { TrackingGateway } from './tracking.gateway';
import { TripsModule } from '../trips/trips.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [TripsModule, JwtModule, ConfigModule],
  providers: [TrackingGateway],
})
export class TrackingModule {}

