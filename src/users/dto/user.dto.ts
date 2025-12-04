import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../entities/user.entity';

export class UpdateProfileDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  profilePicture?: string;

  @ApiProperty({
    required: false,
    description: 'Indique si l’utilisateur souhaite devenir conducteur',
  })
  @IsOptional()
  role?: UserRole;
}

export class UploadKycDto {
  @ApiProperty({ required: false, description: 'Numéro de document ou référence' })
  @IsString()
  @IsOptional()
  documentNumber?: string;
}

