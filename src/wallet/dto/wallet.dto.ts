import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
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
