import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import { AdminDateRangeDto } from '../../common/pagination/admin-query';
import { AdminBulkIdsDto } from '../../common/pagination/admin-bulk';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';
import { ReportReason, ReportStatus } from '../entities/user-report.entity';

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

export class ListAdminUserReportsQueryDto extends AdminDateRangeDto {
  @ApiProperty({ required: false, example: 'createdAt:desc' })
  @IsOptional() @IsString() sort?: string;
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

  @ApiProperty({ required: false, enum: ReportStatus })
  @IsEnum(ReportStatus)
  @IsOptional()
  status?: ReportStatus;

  @ApiProperty({ required: false, enum: ReportReason })
  @IsEnum(ReportReason)
  @IsOptional()
  reason?: ReportReason;

  @ApiProperty({
    required: false,
    description: 'Recherche sur le nom ou le telephone des personnes concernees',
  })
  @IsString()
  @IsOptional()
  search?: string;
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

export class BulkReportStatusDto extends IntersectionType(AdminBulkIdsDto, UpdateReportStatusDto) {}

