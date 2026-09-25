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
  Max,
  Matches,
  Min,
} from 'class-validator';
import { PaymentMethod, PaymentProvider } from '../../payments/entities/payment-transaction.entity';

export class RequestWalletWithdrawalDto {
  @ApiProperty({ minimum: 1, example: 50 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1_000_000)
  tokens: number;

  @ApiProperty({ example: '243891234567' })
  @IsString()
  @Matches(/^\+?243\d{9}$/)
  phone: string;

  @ApiProperty({
    description:
      'UUID stable pour une seule demande de retrait, y compris ses retries.',
  })
  @IsUUID('4')
  idempotencyKey: string;
}

export class InitiateWalletTopUpDto {
  @ApiProperty({
    minimum: 1,
    example: 50,
    description: 'Nombre de jetons Zwanga a acheter. 1 jeton = 100 FC/CDF.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.MOBILE_MONEY,
    description: 'Canal FlexPay ou PawaPay utilisé pour acheter les jetons.',
  })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({
    required: false,
    example: '+243891234567',
    description: 'Numéro Mobile Money du client.',
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

  @ApiProperty({
    required: false,
    enum: PaymentProvider,
    enumName: 'PaymentProvider',
  })
  @IsEnum(PaymentProvider)
  @IsOptional()
  preferredProvider?: PaymentProvider;
}

export class TransferWalletPointsDto {
  @ApiProperty({
    minimum: 1,
    example: 2500,
    description:
      'Nombre de jetons Zwanga a partager avec un autre utilisateur.',
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
    description: 'Téléphone du destinataire déjà inscrit sur Zwanga.',
    example: '+243891234567',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  recipientPhone?: string;

  @ApiProperty({
    required: false,
    description: 'Email du destinataire déjà inscrit sur Zwanga.',
    example: 'client@zwanga.cd',
  })
  @IsEmail()
  @IsOptional()
  @MaxLength(160)
  recipientEmail?: string;

  @ApiProperty({
    required: false,
    description: 'Petit message associé au partage de jetons.',
    example: 'Pour ton prochain trajet',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  note?: string;
}
