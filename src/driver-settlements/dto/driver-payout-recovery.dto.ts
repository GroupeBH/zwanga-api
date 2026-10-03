import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RequestPayoutReviewDto {
  @ApiProperty({
    description: 'Motif du signalement',
    minLength: 5,
    maxLength: 500,
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

export class ReconcileDriverPayoutDto {
  @ApiProperty({
    required: false,
    description:
      'Numéro obtenu de FlexPay ; vérifié avant association au retrait',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  orderNumber?: string;
}

export class ResolveDriverPayoutDto extends RequestPayoutReviewDto {
  @ApiProperty({
    description:
      'Référence Zwanga attendue (ID du retrait si aucune transaction)',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  expectedReference: string;

  @ApiProperty({
    description:
      'Référence de confirmation définitive FlexPay ou du dossier de rapprochement, sans secrets',
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  evidenceReference: string;

  @ApiProperty({
    enum: [true],
    description:
      'Attestation administrateur : non-exécution ou annulation définitive confirmée par FlexPay',
  })
  @Equals(true)
  confirmedNotPaid: true;
}

export class ClosePayoutIncidentDto extends RequestPayoutReviewDto {
  @ApiProperty({
    description:
      'Référence du rapprochement financier effectué après succès tardif',
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  evidenceReference: string;
}

export class PayoutRecoveryListDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset = 0;
}
