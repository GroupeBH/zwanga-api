import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '../../payments/entities/payment-transaction.entity';
import { SubscriptionPlan } from '../entities/subscription.entity';
import {
  AdministrativeDocumentType,
  DocumentFundingRequestStatus,
} from '../entities/document-funding-request.entity';

export class SubscribeDto {
  @ApiProperty({
    enum: [SubscriptionPlan.PRO],
    enumName: 'SubscriptionPlan',
    example: SubscriptionPlan.PRO,
  })
  @IsEnum(SubscriptionPlan)
  @IsIn([SubscriptionPlan.PRO], {
    message: 'Le seul abonnement disponible est le pack pro',
  })
  @IsNotEmpty()
  plan: SubscriptionPlan;

  @ApiProperty({
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.MOBILE_MONEY,
  })
  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  paymentMethod: PaymentMethod;

  @ApiProperty({
    required: false,
    description: 'Numero du client pour Mobile Money, commence obligatoirement par +243',
    example: '+243891234567',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  @Matches(/^\+243\d{9}$/, {
    message:
      'Le numero de telephone doit commencer par +243, par exemple +243891234567',
  })
  phone?: string;

  @ApiProperty({
    required: false,
    description: 'URL de redirection apres paiement carte approuve',
    example: 'zwanga://subscriptions/payment?status=success',
  })
  @Matches(
    /^[a-z][a-z0-9+.-]*:\/\//i,
    { message: 'approveUrl doit etre une URL valide' },
  )
  @IsOptional()
  @MaxLength(500)
  approveUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL de redirection apres annulation du paiement carte',
    example: 'zwanga://subscriptions/payment?status=cancel',
  })
  @Matches(
    /^[a-z][a-z0-9+.-]*:\/\//i,
    { message: 'cancelUrl doit etre une URL valide' },
  )
  @IsOptional()
  @MaxLength(500)
  cancelUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL de redirection apres echec du paiement carte',
    example: 'zwanga://subscriptions/payment?status=decline',
  })
  @Matches(
    /^[a-z][a-z0-9+.-]*:\/\//i,
    { message: 'declineUrl doit etre une URL valide' },
  )
  @IsOptional()
  @MaxLength(500)
  declineUrl?: string;
}

export class CreateDocumentFundingRequestDto {
  @ApiProperty({
    enum: AdministrativeDocumentType,
    enumName: 'AdministrativeDocumentType',
    example: AdministrativeDocumentType.TECHNICAL_INSPECTION,
  })
  @IsEnum(AdministrativeDocumentType)
  @IsNotEmpty()
  documentType: AdministrativeDocumentType;

  @ApiProperty({
    required: false,
    description: 'Nom libre du document si le type choisi ne suffit pas',
    example: 'Controle technique du vehicule',
  })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  documentName?: string;

  @ApiProperty({
    required: false,
    minimum: 0,
    description: 'Montant demande pour le financement',
    example: 25000,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  amountRequested?: number;

  @ApiProperty({
    required: false,
    description: 'Devise du montant demande',
    example: 'CDF',
  })
  @IsString()
  @IsOptional()
  @MaxLength(8)
  currency?: string;

  @ApiProperty({
    required: false,
    description: 'Details utiles pour analyser la demande',
    example: 'Le document expire cette semaine.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;
}

export class UpdateDocumentFundingRequestStatusDto {
  @ApiProperty({
    enum: DocumentFundingRequestStatus,
    enumName: 'DocumentFundingRequestStatus',
    example: DocumentFundingRequestStatus.APPROVED,
  })
  @IsEnum(DocumentFundingRequestStatus)
  @IsNotEmpty()
  status: DocumentFundingRequestStatus;

  @ApiProperty({
    required: false,
    description: 'Note interne ou message expliquant la decision',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  adminNote?: string;
}

export class ListDocumentFundingRequestsQueryDto {
  @ApiProperty({
    required: false,
    enum: DocumentFundingRequestStatus,
    enumName: 'DocumentFundingRequestStatus',
  })
  @IsEnum(DocumentFundingRequestStatus)
  @IsOptional()
  status?: DocumentFundingRequestStatus;
}
