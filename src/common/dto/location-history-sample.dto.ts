import { IsDateString, IsNumber, Max, Min } from 'class-validator';

/** Small batch of actual device observations, not synthetic current locations. */
export class LocationHistorySampleDto {
  @IsNumber() @Min(-90) @Max(90) latitude: number;
  @IsNumber() @Min(-180) @Max(180) longitude: number;
  @IsNumber() @Min(0) @Max(70) accuracy: number;
  @IsDateString() recordedAt: string;
}
