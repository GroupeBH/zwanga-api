import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../users/entities/user.entity';

export class RegisterDto {
  @ApiProperty({ example: '+243900000000' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsOptional()
  isDriver: boolean;

  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsNotEmpty()
  role: UserRole;
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

