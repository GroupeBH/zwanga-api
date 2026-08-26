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
      'Numero Mobile Money receveur. Si absent, le telephone du compte chauffeur est utilise.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Cle stable generee par l application. Rejouer la meme cle retourne le meme retrait sans nouveau transfert.',
  })
  @IsOptional()
  @IsUUID('4')
  idempotencyKey?: string;
}
