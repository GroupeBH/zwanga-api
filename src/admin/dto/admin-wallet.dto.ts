import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

export class AdminWalletAdjustmentDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description:
      "Identifiant unique stable de la demande, utilisé pour garantir l'idempotence.",
  })
  @IsUUID()
  requestId: string;

  @ApiProperty({
    example: 25,
    description:
      'Nombre signé de jetons. Une valeur positive crédite le compte et une valeur négative le débite.',
    minimum: -1_000_000,
    maximum: 1_000_000,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @NotEquals(0)
  @Min(-1_000_000)
  @Max(1_000_000)
  amount: number;

  @ApiProperty({
    example: 'Régularisation validée sous le ticket SUP-1042',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
