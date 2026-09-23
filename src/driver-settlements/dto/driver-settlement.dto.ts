import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class RequestDriverPayoutDto {
  @ApiProperty({
    minimum: 1,
    example: 9500,
    description: 'Montant a retirer depuis le solde chauffeur disponible.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({
    required: false,
    example: '+243891234567',
    description:
      'Numéro Mobile Money receveur. Si absent, le téléphone du compte chauffeur est utilisé.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Clé stable générée par l’application. Rejouer la même clé retourne le même retrait sans nouveau transfert.',
  })
  @IsOptional()
  @IsUUID('4')
  idempotencyKey?: string;
}
