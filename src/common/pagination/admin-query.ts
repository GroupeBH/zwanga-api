import { BadRequestException, applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional, ApiQuery } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export class AdminDateRangeDto {
  @ApiPropertyOptional({
    description:
      'UTC date (YYYY-MM-DD, inclusive) or ISO timestamp with timezone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(35)
  from?: string;
  @ApiPropertyOptional({
    description: 'UTC date (inclusive) or ISO timestamp (exclusive)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(35)
  to?: string;
}
export class AdminOverviewDto extends AdminDateRangeDto {
  @ApiPropertyOptional({ enum: ['previous'] })
  @IsOptional()
  @IsIn(['previous'])
  compare?: 'previous';
}
export class AdminPaymentStatsDto extends AdminDateRangeDto {
  @ApiPropertyOptional({
    enum: ['day', 'provider', 'operator'],
    default: 'day',
  })
  @IsOptional()
  @IsIn(['day', 'provider', 'operator'])
  groupBy?: 'day' | 'provider' | 'operator';
}
export class AdminSearchDto {
  @ApiPropertyOptional({
    description: 'Phone, trip UUID, payment reference, ticket UUID or subject',
    maxLength: 160,
  })
  @IsString()
  @MaxLength(160)
  q: string;
}
export interface AdminListOptions {
  from?: string;
  to?: string;
  sort?: string;
}
export const ApiAdminListQuery = (fields: string[]) =>
  applyDecorators(
    ApiQuery({
      name: 'from',
      required: false,
      type: String,
      description:
        'Inclusive creation date (UTC YYYY-MM-DD or ISO timestamp with timezone)',
    }),
    ApiQuery({
      name: 'to',
      required: false,
      type: String,
      description: 'Inclusive UTC calendar day or exclusive ISO timestamp',
    }),
    ApiQuery({
      name: 'sort',
      required: false,
      type: String,
      description: `field:asc|desc; allowed fields: ${fields.join(', ')}. Stable ID tie-breaker.`,
    }),
  );
const DAY = 86_400_000;
function boundary(value: string | undefined, end: boolean): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException('Date invalide');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (
    !day &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw new BadRequestException(
      'Utilisez une date YYYY-MM-DD ou ISO avec fuseau',
    );
  }
  const calendar = new Date(value.slice(0, 10) + 'T00:00:00Z');
  const date = new Date(day ? value + 'T00:00:00Z' : value);
  if (
    !Number.isFinite(date.getTime()) ||
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== value.slice(0, 10)
  ) {
    throw new BadRequestException('Date invalide');
  }
  return new Date(date.getTime() + (day && end ? DAY : 0));
}
export function adminRange(
  input: AdminDateRangeDto = {},
  stats = false,
  now = new Date(),
) {
  let from = boundary(input.from, false),
    to = boundary(input.to, true);
  if (stats) {
    to ??= new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY,
    );
    from ??= new Date(to.getTime() - 30 * DAY);
  }
  if (
    from &&
    to &&
    (from >= to || (stats && to.getTime() - from.getTime() > 366 * DAY))
  ) {
    throw new BadRequestException(
      'Période invalide (statistiques : maximum 366 jours)',
    );
  }
  return { from, to };
}
export function applyAdminRange<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  column: string,
  input: AdminDateRangeDto,
) {
  const { from, to } = adminRange(input);
  if (from) qb.andWhere(`${column} >= :adminFrom`, { adminFrom: from });
  if (to) qb.andWhere(`${column} < :adminTo`, { adminTo: to });
  return qb;
}
export function applyAdminList<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  alias: string,
  input: AdminListOptions = {},
  fields = ['createdAt', 'updatedAt', 'status'],
  fallback = 'createdAt:desc',
) {
  applyAdminRange(qb, `${alias}.createdAt`, input);
  const value = input.sort ?? fallback;
  if (typeof value !== 'string') throw new BadRequestException('Tri invalide');
  const match = /^([A-Za-z][A-Za-z0-9]*):(asc|desc)$/i.exec(value);
  if (!match || !fields.includes(match[1]))
    throw new BadRequestException(
      `Tri autorisé : ${fields.join(', ')}:asc|desc`,
    );
  qb.orderBy(`${alias}.${match[1]}`, match[2].toUpperCase() as 'ASC' | 'DESC');
  if (match[1] !== 'id') qb.addOrderBy(`${alias}.id`, 'ASC');
  return qb;
}
export function literalSearch(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
