import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  PaymentMethod,
  PaymentProvider,
} from '../entities/payment-transaction.entity';

export class InitiatePaymentDto {
  @ApiProperty({
    required: true,
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.MOBILE_MONEY,
    description: 'Canal technique utilisé pour la transaction (FlexPay ou PawaPay).',
  })
  @IsEnum(PaymentMethod, {
    message: 'La méthode de paiement sélectionnée est invalide',
  })
  method: PaymentMethod;

  @ApiProperty({
    required: false,
    description: 'Numéro du client au format international pour Mobile Money',
    example: '243891234567',
  })
  @IsString({
    message: 'Le numéro de téléphone doit être une chaîne de caractères',
  })
  @IsOptional()
  @MaxLength(20, {
    message: 'Le numéro de téléphone ne peut pas dépasser 20 caractères',
  })
  phone?: string;

  @ApiProperty({
    required: false,
    description: 'URL appelée après un paiement carte approuvé',
    example: 'zwanga://payments/trips?status=success',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  approveUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL appelée après une annulation du paiement carte',
    example: 'zwanga://payments/trips?status=cancel',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  cancelUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL appelée après un refus du paiement carte',
    example: 'zwanga://payments/trips?status=decline',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  declineUrl?: string;

  @ApiProperty({
    required: false,
    enum: PaymentProvider,
    enumName: 'PaymentProvider',
    example: PaymentProvider.PAWAPAY,
    description:
      'Prestataire préféré. Si indisponible, le backend bascule vers l’autre canal Mobile Money.',
  })
  @IsEnum(PaymentProvider, {
    message: 'Le prestataire de paiement sélectionné est invalide',
  })
  @IsOptional()
  preferredProvider?: PaymentProvider;
}

export class FlexPayCallbackDto {
  @ApiProperty({ required: false, example: '0' })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiProperty({ required: false, example: '20/03/2024 17:30:45' })
  @IsString()
  @IsOptional()
  created_at?: string;

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
    description: 'Référence de la transaction chez l’opérateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  provider_reference?: string;

  @ApiProperty({
    required: false,
    description: 'Référence de la transaction chez l’opérateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  Provider_reference?: string;

  @ApiProperty({
    required: false,
    description: 'Référence de la transaction chez l’opérateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  providerReference?: string;

  @ApiProperty({
    required: false,
    description: 'Référence de la transaction chez l’opérateur',
    example: '7KI81020PHS',
  })
  @IsString()
  @IsOptional()
  ProviderReference?: string;

  @ApiProperty({
    required: false,
    description: 'Numéro de commande généré par FlexPay',
    example: '9bsTX7qXdpQe243815877848',
  })
  @IsString()
  @IsOptional()
  orderNumber?: string;

  @ApiProperty({
    required: false,
    description: 'Numéro de commande généré par FlexPay',
    example: '9bsTX7qXdpQe243815877848',
  })
  @IsString()
  @IsOptional()
  OrderNumber?: string;

  @ApiProperty({
    required: false,
    description: 'Numéro de commande généré par FlexPay',
    example: '9bsTX7qXdpQe243815877848',
  })
  @IsString()
  @IsOptional()
  order_number?: string;
}

export class PawaPayCallbackDto {
  @ApiProperty({ required: false })
  @IsOptional()
  depositId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  payoutId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  refundId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  status?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  amount?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  currency?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  clientReferenceId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  providerTransactionId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  authorizationUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  failureReason?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  payer?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  recipient?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  data?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
