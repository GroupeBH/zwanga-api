import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../users/entities/user.entity';
import { CreateVehicleDto } from '../../vehicles/dto/vehicle.dto';

const toTrimmedString = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null) {
    return value;
  }

  return String(value).trim();
};

export class RegisterDto {
  @ApiProperty({ example: '+243900000000' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ example: '1234', description: 'PIN a 4 chiffres' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(4)
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin: string;

  @ApiProperty({ required: false, example: true, description: 'Indique si utilisateur est conducteur' })
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
    description: 'Infos vehicule (conducteurs uniquement)',
  })
  @ValidateNested()
  @IsOptional()
  @Type(() => CreateVehicleDto)
  vehicle?: CreateVehicleDto;
}

export class LoginDto {
  @ApiProperty({ example: '0831919710' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    required: false,
    example: '1234',
    description: 'PIN a 4 chiffres - requis si newPin absent',
  })
  @Transform(toTrimmedString)
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
    description: 'Nouveau PIN a 4 chiffres - utilise si PIN oublie',
  })
  @Transform(toTrimmedString)
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

export class GoogleMobileAuthDto {
  @ApiProperty({
    description: 'Google ID token obtenu cote mobile (Expo / React Native)',
  })
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @ApiProperty({
    description: 'Numero de telephone requis au premier login Google',
    example: '+243900000000',
    required: false,
  })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  phone?: string;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;
}
