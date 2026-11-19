import {
  IsBoolean,
  IsString,
  Length,
  IsUUID,
  IsIn,
  IsOptional,
} from 'class-validator';

export class CreditPartyDto {
  @IsBoolean() supplier: boolean;
  @IsBoolean() funder: boolean;
  @IsBoolean() operator: boolean;
  @IsBoolean() enabled: boolean;
  @IsString() @Length(6, 160) authorizationReference: string;
}

export class CreditGrantDto {
  @IsUUID() userId: string;
  @IsIn([
    'manager',
    'analyst',
    'stock',
    'documents',
    'accountant',
    'collector',
    'funder',
    'supplier',
    'auditor',
  ])
  role: string;
  @IsOptional() @IsUUID() organizationId?: string;
  @IsBoolean() enabled: boolean;
}
