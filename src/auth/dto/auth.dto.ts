import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  ValidateNested,
  ValidateIf,
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

  @ApiProperty({ example: '1234', description: 'PIN à 4 chiffres' })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(4)
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin: string;

  @ApiProperty({ required: false, example: true, description: 'Indique si l\'utilisateur est conducteur' })
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
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ 
    required: false,
    example: '1234', 
    description: 'PIN à 4 chiffres - requis si newPin n\'est pas fourni' 
  })
  @ValidateIf((o) => !o.newPin)
  @IsString()
  @IsNotEmpty({ message: 'PIN is required if newPin is not provided' })
  @MinLength(4)
  @MaxLength(4)
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin?: string;

  @ApiProperty({ 
    required: false,
    example: '5678', 
    description: 'Nouveau PIN à 4 chiffres - utilisé si l\'ancien PIN est oublié (remplace pin)' 
  })
  @ValidateIf((o) => !o.pin)
  @IsString()
  @IsNotEmpty({ message: 'newPin is required if PIN is not provided' })
  @MinLength(4)
  @MaxLength(4)
  @Matches(/^\d{4}$/, { message: 'New PIN must be exactly 4 digits' })
  newPin?: string;
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

