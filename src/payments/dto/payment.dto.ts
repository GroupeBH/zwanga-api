import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '../entities/payment-transaction.entity';

export class InitiatePaymentDto {
  @ApiProperty({
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.MOBILE_MONEY,
  })
  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  method: PaymentMethod;

  @ApiProperty({
    required: false,
    description: 'Numero du client au format international pour Mobile Money',
    example: '243891234567',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;
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
