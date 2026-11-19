import { Allow, IsIn, IsOptional } from 'class-validator';
import { LegacyPageQuery } from '../../common/legacy-page';

export class LegacyRequestPageDto extends LegacyPageQuery {
  @IsOptional()
  @IsIn(['home', 'activity'])
  scope?: string;
  // Legacy clients may send this field. It is never used for authorization or filtering.
  @Allow()
  driverId?: unknown;
}
