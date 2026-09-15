import { IsIn, IsISO8601, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { RideDecision, RideStage } from './ride-declaration.model';

export class RideDeclarationDto {
  @IsUUID() actorUserId: string;
  @IsUUID('4') eventId: string;
  @IsIn(['pickup', 'dropoff']) stage: RideStage;
  @IsIn(['confirm', 'reject']) decision: RideDecision;
  @IsISO8601({ strict: true }) occurredAt: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10000) accuracy?: number;
}
