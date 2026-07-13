import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '../entities/payment-transaction.entity';

export class InitiatePaymentDto {
  @ApiProperty({
    required: true,
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.MOBILE_MONEY,
    description: 'Canal technique utilise pour la transaction FlexPay.',
  })
  @IsEnum(PaymentMethod, {
    message: 'La methode de paiement selectionnee est invalide',
  })
  method: PaymentMethod;

  @ApiProperty({
    required: false,
    description: 'Numero du client au format international pour Mobile Money',
    example: '243891234567',
  })
  @IsString({
    message: 'Le numero de telephone doit etre une chaine de caracteres',
  })
  @IsOptional()
  @MaxLength(20, {
    message: 'Le numero de telephone ne peut pas depasser 20 caracteres',
  })
  phone?: string;

  @ApiProperty({
    required: false,
    description: 'URL appelee apres un paiement carte approuve',
    example: 'zwanga://payments/trips?status=success',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  approveUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL appelee apres une annulation du paiement carte',
    example: 'zwanga://payments/trips?status=cancel',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  cancelUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL appelee apres un refus du paiement carte',
    example: 'zwanga://payments/trips?status=decline',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  declineUrl?: string;
}

export class FlexPayCallbackDto {
  @ApiProperty({ required: false, example: '0' })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({ required: false, example: '0' })
  @IsString()
  @IsOptional()
  Code?: string;

  @ApiProperty({ required: false, example: 'Transaction traitee' })
  @IsString()
  @IsOptional()
  message?: string;

  @ApiProperty({ required: false, example: 'Transaction traitee' })
  @IsString()
  @IsOptional()
  Message?: string;

  @ApiProperty({ required: false, example: 'SUB-1700000000000-ABCD1234' })
  @IsString()
  @IsOptional()
  reference?: string;

  @ApiProperty({ required: false, example: 'SUB-1700000000000-ABCD1234' })
  @IsString()
  @IsOptional()
  Reference?: string;

  @ApiProperty({
    required: false,
    description: 'Reference de la transaction chez l operateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  provider_reference?: string;

  @ApiProperty({
    required: false,
    description: 'Reference de la transaction chez l operateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  Provider_reference?: string;

  @ApiProperty({
    required: false,
    description: 'Reference de la transaction chez l operateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  providerReference?: string;

  @ApiProperty({
    required: false,
    description: 'Reference de la transaction chez l operateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  ProviderReference?: string;

  @ApiProperty({
    required: false,
    description: 'Numero de commande genere par FlexPay',
    example: '9bsTX7qXdpQe243815877848',
  })
  @IsString()
  @IsOptional()
  orderNumber?: string;

  @ApiProperty({
    required: false,
    description: 'Numero de commande genere par FlexPay',
    example: '9bsTX7qXdpQe243815877848',
  })
  @IsString()
  @IsOptional()
  OrderNumber?: string;

  @ApiProperty({
    required: false,
    description: 'Numero de commande genere par FlexPay',
    example: '9bsTX7qXdpQe243815877848',
  })
  @IsString()
  @IsOptional()
  order_number?: string;
}
