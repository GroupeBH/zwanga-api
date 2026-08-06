import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '../../payments/entities/payment-transaction.entity';

export class InitiateWalletTopUpDto {
  @ApiProperty({
    minimum: 1,
    example: 5000,
    description: 'Montant a convertir en points Zwanga. 1 point = 1 CDF.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.MOBILE_MONEY,
    description: 'Canal FlexPay utilise pour acheter les points.',
  })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({
    required: false,
    example: '+243891234567',
    description: 'Numero Mobile Money du client.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  approveUrl?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  cancelUrl?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  declineUrl?: string;
}

export class TransferWalletPointsDto {
  @ApiProperty({
    minimum: 1,
    example: 2500,
    description:
      'Nombre de points Zwanga a partager avec un autre utilisateur.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({
    required: false,
    description: "ID de l'utilisateur destinataire.",
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsOptional()
  recipientUserId?: string;

  @ApiProperty({
    required: false,
    description: 'Telephone du destinataire deja inscrit sur Zwanga.',
    example: '+243891234567',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  recipientPhone?: string;

  @ApiProperty({
    required: false,
    description: 'Email du destinataire deja inscrit sur Zwanga.',
    example: 'client@zwanga.cd',
  })
  @IsEmail()
  @IsOptional()
  @MaxLength(160)
  recipientEmail?: string;

  @ApiProperty({
    required: false,
    description: 'Petit message associe au partage de points.',
    example: 'Pour ton prochain trajet',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  note?: string;
}
