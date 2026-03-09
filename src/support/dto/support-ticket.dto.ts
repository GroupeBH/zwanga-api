import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from '../entities/support-ticket.entity';

export class CreateSupportTicketDto {
  @ApiProperty({
    description: 'Sujet du ticket',
    maxLength: 120,
    example: 'Problème de paiement',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  subject: string;

  @ApiProperty({
    description: 'Message initial du ticket',
    example: 'Le paiement est débité mais la réservation reste en attente.',
  })
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiProperty({
    required: false,
    enum: SupportTicketCategory,
    default: SupportTicketCategory.GENERAL,
  })
  @IsEnum(SupportTicketCategory)
  @IsOptional()
  category?: SupportTicketCategory = SupportTicketCategory.GENERAL;

  @ApiProperty({
    required: false,
    enum: SupportTicketPriority,
    default: SupportTicketPriority.MEDIUM,
  })
  @IsEnum(SupportTicketPriority)
  @IsOptional()
  priority?: SupportTicketPriority = SupportTicketPriority.MEDIUM;
}

export class ListSupportTicketsQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number = 20;

  @ApiProperty({ required: false, enum: SupportTicketStatus })
  @IsEnum(SupportTicketStatus)
  @IsOptional()
  status?: SupportTicketStatus;

  @ApiProperty({ required: false, enum: SupportTicketPriority })
  @IsEnum(SupportTicketPriority)
  @IsOptional()
  priority?: SupportTicketPriority;

  @ApiProperty({ required: false, enum: SupportTicketCategory })
  @IsEnum(SupportTicketCategory)
  @IsOptional()
  category?: SupportTicketCategory;

  @ApiProperty({
    required: false,
    description: 'Recherche sur le sujet',
  })
  @IsString()
  @IsOptional()
  search?: string;
}

export class ListAdminSupportTicketsQueryDto extends ListSupportTicketsQueryDto {
  @ApiProperty({ required: false, description: 'Filtrer par utilisateur' })
  @IsUUID()
  @IsOptional()
  userId?: string;

  @ApiProperty({ required: false, description: 'Filtrer par admin assigné' })
  @IsUUID()
  @IsOptional()
  assignedAdminId?: string;

  @ApiProperty({
    required: false,
    description: 'Limiter aux tickets non assignés',
    default: false,
  })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  unassignedOnly?: boolean = false;
}

export class AddSupportTicketMessageDto {
  @ApiProperty({ description: 'Contenu du message' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    required: false,
    default: false,
    description: 'Message interne (visible uniquement par les admins)',
  })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  isInternal?: boolean = false;
}

export class AssignSupportTicketDto {
  @ApiProperty({
    required: false,
    description:
      'ID de l’admin à assigner. Si absent, assigne le ticket à l’admin courant.',
  })
  @IsUUID()
  @IsOptional()
  adminId?: string;
}

export class UpdateSupportTicketStatusDto {
  @ApiProperty({ enum: SupportTicketStatus })
  @IsEnum(SupportTicketStatus)
  status: SupportTicketStatus;

  @ApiProperty({
    required: false,
    description: 'Résumé de résolution (utile quand statut resolved/closed)',
  })
  @IsString()
  @IsOptional()
  resolutionSummary?: string;

  @ApiProperty({
    required: false,
    description: 'Note interne admin ajoutée lors du changement de statut',
  })
  @IsString()
  @IsOptional()
  internalNote?: string;
}

