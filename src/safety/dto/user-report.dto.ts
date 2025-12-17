import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';
import { ReportReason } from '../entities/user-report.entity';

export class CreateUserReportDto {
  @ApiProperty({ description: 'ID de l\'utilisateur signalé' })
  @IsUUID()
  @IsNotEmpty()
  reportedUserId: string;

  @ApiProperty({ description: 'Raison du signalement', enum: ReportReason })
  @IsEnum(ReportReason)
  reason: ReportReason;

  @ApiProperty({ description: 'Description détaillée du signalement' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ description: 'ID du trip associé (si applicable)', required: false })
  @IsUUID()
  @IsOptional()
  tripId?: string;

  @ApiProperty({ description: 'ID du booking associé (si applicable)', required: false })
  @IsUUID()
  @IsOptional()
  bookingId?: string;
}

export class UpdateReportStatusDto {
  @ApiProperty({ description: 'Nouveau statut du signalement', enum: ['under_review', 'resolved', 'dismissed'] })
  @IsEnum(['under_review', 'resolved', 'dismissed'])
  status: 'under_review' | 'resolved' | 'dismissed';

  @ApiProperty({ description: 'Notes de l\'admin', required: false })
  @IsString()
  @IsOptional()
  adminNotes?: string;
}

