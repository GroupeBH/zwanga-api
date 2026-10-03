import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Compatibility routes keep their array response; new clients use cursor endpoints. */
export class LegacyPageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000)
  page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}
export function legacyPage(options: LegacyPageQuery = {}, defaultLimit = 100) {
  const take = Number.isFinite(options.limit) ? Math.min(100, Math.max(1, Math.trunc(options.limit!))) : defaultLimit;
  const page = Number.isFinite(options.page) ? Math.min(10000, Math.max(1, Math.trunc(options.page!))) : 1;
  return { take, skip: (page - 1) * take };
}
