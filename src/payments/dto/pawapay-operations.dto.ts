import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class PawaPayPredictProviderDto {
  @ApiProperty({ example: '+243891234567' })
  @IsString()
  @Length(9, 20)
  phone: string;
}

export class PawaPayCreateRefundDto {
  @ApiProperty({ description: 'UUIDv4 stable pour les reprises idempotentes' })
  @IsUUID('4')
  refundId: string;

  @ApiProperty({ description: 'Identifiant interne du dépôt Zwanga' })
  @IsUUID()
  paymentTransactionId: string;

  @ApiProperty({ description: 'Montant à rembourser dans la devise du dépôt' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  amount: number;

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @Length(5, 500)
  reason: string;

  @ApiPropertyOptional({
    description: 'Référence de la régularisation métier déjà effectuée',
  })
  @IsOptional()
  @IsString()
  @Length(3, 120)
  businessReversalReference?: string;
}
