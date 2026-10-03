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
import { PaymentMethod, PaymentProvider } from '../../payments/entities/payment-transaction.entity';
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
  @IsEnum(SubscriptionPlan, {
    message: "Le type d'abonnement sélectionné est invalide",
  })
  @IsIn([SubscriptionPlan.PRO], {
    message: 'Le seul abonnement disponible est le pack pro',
  })
  @IsNotEmpty({ message: "Le type d'abonnement est requis" })
  plan: SubscriptionPlan;

  @ApiProperty({
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.MOBILE_MONEY,
  })
  @IsEnum(PaymentMethod, {
    message: 'La méthode de paiement sélectionnée est invalide',
  })
  @IsNotEmpty({ message: 'La méthode de paiement est requise' })
  paymentMethod: PaymentMethod;

  @ApiProperty({
    required: false,
    description:
      'Numéro du client pour Mobile Money, commence obligatoirement par +243',
    example: '+243891234567',
  })
  @IsString({
    message: 'Le numéro de téléphone doit être une chaîne de caractères',
  })
  @IsOptional()
  @MaxLength(20, {
    message: 'Le numéro de téléphone ne peut pas dépasser 20 caractères',
  })
  @Matches(/^\+243\d{9}$/, {
    message:
      'Le numéro de téléphone doit commencer par +243, par exemple +243891234567',
  })
  phone?: string;

  @ApiProperty({
    required: false,
    description: 'URL de redirection après paiement carte approuvé',
    example: 'zwanga://subscriptions/payment?status=success',
  })
  @Matches(/^[a-z][a-z0-9+.-]*:\/\//i, {
    message: 'approveUrl doit être une URL valide',
  })
  @IsOptional()
  @MaxLength(500)
  approveUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL de redirection après annulation du paiement carte',
    example: 'zwanga://subscriptions/payment?status=cancel',
  })
  @Matches(/^[a-z][a-z0-9+.-]*:\/\//i, {
    message: 'cancelUrl doit être une URL valide',
  })
  @IsOptional()
  @MaxLength(500)
  cancelUrl?: string;

  @ApiProperty({
    required: false,
    description: 'URL de redirection après échec du paiement carte',
    example: 'zwanga://subscriptions/payment?status=decline',
  })
  @Matches(/^[a-z][a-z0-9+.-]*:\/\//i, {
    message: 'declineUrl doit être une URL valide',
  })
  @IsOptional()
  @MaxLength(500)
  declineUrl?: string;

  @ApiProperty({
    required: false,
    enum: PaymentProvider,
    enumName: 'PaymentProvider',
    description:
      'Prestataire préféré. Si indisponible, le backend bascule vers l’autre canal Mobile Money.',
  })
  @IsEnum(PaymentProvider)
  @IsOptional()
  preferredProvider?: PaymentProvider;

  @ApiProperty({ required: false, description: 'Opérateur Mobile Money pawaPay choisi par le client' })
  @IsString()
  @IsOptional()
  @MaxLength(40)
  pawaPayOperator?: string;
}

export class SubscribeWithPointsDto {
  @ApiProperty({
    enum: [SubscriptionPlan.PRO],
    enumName: 'SubscriptionPlan',
    example: SubscriptionPlan.PRO,
  })
  @IsEnum(SubscriptionPlan, {
    message: "Le type d'abonnement sélectionné est invalide",
  })
  @IsIn([SubscriptionPlan.PRO], {
    message: 'Le seul abonnement disponible est le pack pro',
  })
  @IsNotEmpty({ message: "Le type d'abonnement est requis" })
  plan: SubscriptionPlan;
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
    example: 'Contrôle technique du véhicule',
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
    description: 'Détails utiles pour analyser la demande',
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
