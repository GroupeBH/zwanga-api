import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ResolvePayoutNotPaidDto {
  @ApiProperty({
    description: 'Motif de la résolution',
    minLength: 5,
    maxLength: 500,
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;

  @ApiProperty({
    description:
      'Référence Zwanga attendue, ou ID du retrait si aucune transaction',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  expectedReference: string;

  @ApiProperty({
    description:
      'Référence de confirmation définitive de non-exécution ou annulation FlexPaie, sans secrets',
  })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(200)
  evidenceReference: string;

  @ApiProperty({
    enum: [true],
    description:
      'Attestation : FlexPaie a confirmé définitivement la non-exécution, pas seulement un solde insuffisant',
  })
  @Equals(true)
  confirmedNotPaid: true;
}
