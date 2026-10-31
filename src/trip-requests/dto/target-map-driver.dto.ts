import { IsISO8601, Matches } from 'class-validator';

export class TargetMapDriverDto {
  @Matches(/^[a-f0-9]{64}$/)
  markerId: string;

  @IsISO8601({ strict: true })
  expectedUpdatedAt: string;
}
