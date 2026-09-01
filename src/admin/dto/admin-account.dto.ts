import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';

const toTrimmedString = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null) {
    return value;
  }

  return String(value).trim();
};

export class CreateAdminAccountDto {
  @ApiProperty({ example: '+243900000000' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?\d[\d\s().-]{7,20}$/)
  phone: string;

  @ApiProperty({ example: 'Alice' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Admin' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({
    example: 'Temporaire-2026!',
    description:
      "Mot de passe temporaire transmis hors de l'application à l'administrateur concerné. Si le numéro appartient déjà à un compte public, il devient le nouveau mot de passe admin.",
  })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  defaultPassword: string;
}

export class AdminAccountResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  role: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  isPhoneVerified: boolean;

  @ApiProperty()
  passwordChangeRequired: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
