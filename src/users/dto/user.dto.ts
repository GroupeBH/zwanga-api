import { IsBoolean, IsOptional, IsString, IsNotEmpty, IsEnum, MinLength, MaxLength, Matches, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { UserRole } from '../entities/user.entity';

export enum PhoneVerificationContext {
  REGISTRATION = 'registration',
  LOGIN = 'login',
  UPDATE = 'update',
}

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

export class SendPhoneVerificationOtpDto {
  @ApiProperty({
    description: 'Numéro de téléphone à vérifier',
    example: '+243900000000',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'Contexte de la vérification : registration (inscription), login (connexion), ou update (mise à jour)',
    enum: PhoneVerificationContext,
    enumName: 'PhoneVerificationContext',
    example: 'login',
  })
  @Transform(({ value }) => {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.toLowerCase().trim();
      // Check if the normalized value is a valid enum value
      if (Object.values(PhoneVerificationContext).includes(normalized as PhoneVerificationContext)) {
        return normalized;
      }
    }
    return value;
  })
  @IsNotEmpty({ message: 'context should not be empty' })
  @IsEnum(PhoneVerificationContext, {
    message: 'context must be one of the following values: registration, login, update',
  })
  context: PhoneVerificationContext;
}

export class ChangePinDto {
  @ApiProperty({ 
    required: false,
    example: '1234', 
    description: 'Ancien PIN (4 chiffres) - optionnel si oublié' 
  })
  @IsOptional()
  @ValidateIf((o) => o.oldPin !== undefined && o.oldPin !== null)
  @IsString()
  @MinLength(4)
  @MaxLength(4)
  @Matches(/^\d{4}$/, { message: 'Old PIN must be exactly 4 digits' })
  oldPin?: string;

  @ApiProperty({ example: '5678', description: 'Nouveau PIN (4 chiffres)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(4)
  @Matches(/^\d{4}$/, { message: 'New PIN must be exactly 4 digits' })
  newPin: string;
}

export class VerifyPhoneOtpDto {
  @ApiProperty({
    description: 'Numéro de téléphone à vérifier',
    example: '+243900000000',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: 'Code OTP reçu par SMS',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  otp: string;
}

