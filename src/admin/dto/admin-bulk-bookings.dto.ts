import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminBulkIdsDto } from '../../common/pagination/admin-bulk';

export class AdminBulkBookingsDto extends AdminBulkIdsDto {
  @ApiProperty({ enum: ['accepted', 'rejected', 'cancelled'] })
  @IsIn(['accepted', 'rejected', 'cancelled'])
  status: 'accepted' | 'rejected' | 'cancelled';
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
