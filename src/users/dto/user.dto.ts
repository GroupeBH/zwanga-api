import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
  @IsBoolean()
  @IsOptional()
  wantsToBeDriver?: boolean;
}

export class UploadKycDto {
  @ApiProperty({ required: false, description: 'Numéro de document ou référence' })
  @IsString()
  @IsOptional()
  documentNumber?: string;
}

