import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../users/entities/user.entity';
import { CreateVehicleDto } from '../../vehicles/dto/vehicle.dto';

export class RegisterDto {
  @ApiProperty({ example: '+243900000000' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ required: false, example: true, description: 'Indique si l’utilisateur est conducteur' })
  @IsBoolean()
  @IsOptional()
  isDriver?: boolean;

  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ enum: UserRole, example: UserRole.DRIVER })
  @IsNotEmpty()
  role: UserRole;

  @ApiProperty({
    required: false,
    type: () => CreateVehicleDto,
    description: 'Informations du véhicule (uniquement pour les conducteurs)',
  })
  @ValidateNested()
  @IsOptional()
  @Type(() => CreateVehicleDto)
  vehicle?: CreateVehicleDto;
}

export class LoginDto {

  @ApiProperty({ example: '0831919710' })
  @IsNotEmpty()
  phone: string;

  // @ApiProperty({ example: 'password123' })
  // @IsString()
  // @IsNotEmpty()
  // password: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;
}

