import { IsISO8601, Matches } from 'class-validator';

export class MapDriverQuery {
  @Matches(/^[a-f0-9]{64}$/)
  markerId: string;
}

export class TargetMapDriverDto extends MapDriverQuery {

  @IsISO8601({ strict: true })
  expectedUpdatedAt: string;
}
