import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const trim = ({ value }: TransformFnParams): unknown =>
  value === undefined || value === null ? value : String(value).trim();

export class ValidateReferralCodeDto {
  @ApiProperty({ example: 'ZW7K9M2P4Q' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9]+$/)
  code: string;
}

export class ResolveReferralAttributionDto {
  @ApiProperty({ example: 'a19d93f458a64d75b0e2b0f36073cd51' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  referralToken: string;
}

export class ReferralAttributionDto {
  @ApiProperty({
    required: false,
    enum: ['chottulink', 'branch'],
    description: 'Fournisseur ayant resolu le lien',
  })
  @IsIn(['chottulink', 'branch'])
  @IsOptional()
  referralProvider?: 'chottulink' | 'branch';

  @ApiProperty({ required: false })
  @Transform(trim)
  @IsString()
  @IsOptional()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  referralToken?: string;

  @ApiProperty({
    required: false,
    example: 'https://zwanga.chottu.link/abc123',
  })
  @Transform(trim)
  @IsString()
  @IsOptional()
  @MaxLength(500)
  referralReferringLink?: string;

  @ApiProperty({ required: false, example: '2026-08-25T10:00:00.000Z' })
  @IsDateString()
  @IsOptional()
  referralCapturedAt?: string;
}

export class RequestReferralWithdrawalDto {
  @ApiProperty({ minimum: 50, example: 50 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  tokens: number;

  @ApiProperty({ required: false, example: '+243891234567' })
  @Transform(trim)
  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;
}
