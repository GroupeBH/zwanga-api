import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SubscriptionPlan } from '../entities/subscription.entity';
import {
  AdministrativeDocumentType,
  DocumentFundingRequestStatus,
} from '../entities/document-funding-request.entity';

export class SubscribeDto {
  @ApiProperty({
    enum: SubscriptionPlan,
    enumName: 'SubscriptionPlan',
    example: SubscriptionPlan.MONTHLY,
  })
  @IsEnum(SubscriptionPlan)
  @IsNotEmpty()
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
