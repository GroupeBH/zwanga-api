import {
  IsBoolean,
  IsEnum,
  IsIn,
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
import { UserGender, UserRole } from '../../users/entities/user.entity';
import { SELF_SERVICE_USER_ROLES } from '../../users/user-role.policy';
import { CreateVehicleDto } from '../../vehicles/dto/vehicle.dto';
import { ReferralAttributionDto } from '../../referrals/dto/referral.dto';
import { normalizeLegalName } from '../../users/legal-identity.util';

const toTrimmedString = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null) {
    return value;
  }

  return String(value).trim();
};

const toNormalizedLegalName = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null) {
    return value;
  }

  return typeof value === 'string' ? normalizeLegalName(value) : value;
};

export class RegisterDto extends ReferralAttributionDto {
  @ApiProperty({
    required: false,
    example: 'ZW7K9M2P4Q',
    description:
      'Code du parrain, applicable uniquement a la creation du compte',
  })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9]+$/)
  referralCode?: string;

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

  @ApiProperty({
    required: false,
    example: true,
    description: 'Indique si utilisateur est conducteur',
  })
  @IsBoolean()
  @IsOptional()
  isDriver?: boolean;

  @ApiProperty({ example: 'John' })
  @Transform(toNormalizedLegalName)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @Transform(toNormalizedLegalName)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({
    enum: UserGender,
    enumName: 'UserGender',
    example: UserGender.FEMALE,
    required: false,
    nullable: true,
    description: "Sexe choisi par l'utilisateur",
  })
  @IsEnum(UserGender)
  @IsOptional()
  gender?: UserGender | null;

  @ApiProperty({
    enum: SELF_SERVICE_USER_ROLES,
    example: UserRole.DRIVER,
    description: 'Role public autorise: driver ou passenger',
  })
  @IsIn(SELF_SERVICE_USER_ROLES)
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

export class AdminLoginDto {
  @ApiProperty({ example: '+243900000000' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    required: false,
    example: 'Temporaire-2026!',
    description:
      'Mot de passe administrateur. Les anciens PIN admin de 4 chiffres restent acceptés à la connexion.',
  })
  @Transform(toTrimmedString)
  @ValidateIf((o) => !o.pin)
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(128)
  password?: string;

  @ApiProperty({
    required: false,
    example: '1234',
    description: 'Compatibilité temporaire avec les anciens PIN admin.',
  })
  @Transform(toTrimmedString)
  @ValidateIf((o) => !o.password)
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(4)
  @Matches(/^\d{4}$/, { message: 'PIN must be exactly 4 digits' })
  pin?: string;
}

export class AdminChangePasswordDto {
  @ApiProperty({ example: 'Temporaire-2026!' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({ example: 'NouveauMotDePasse-2026!' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

export class AdminBootstrapSendOtpDto {
  @ApiProperty({ example: '+243831919710' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  phone: string;
}

export class AdminBootstrapConfirmDto extends AdminBootstrapSendOtpDto {
  @ApiProperty({ example: '123456' })
  @Transform(toTrimmedString)
  @IsString()
  @IsNotEmpty()
  otp: string;

  @ApiProperty({ required: false, example: 'Buania' })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  @MaxLength(100)
  firstName?: string;

  @ApiProperty({ required: false, example: 'Superadmin' })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  @MaxLength(100)
  lastName?: string;

  @ApiProperty({
    required: false,
    example: 'MotDePasseTemporaire-2026!',
    description:
      'Mot de passe temporaire. Si absent, ADMIN_BOOTSTRAP_DEFAULT_PASSWORD est utilisé côté serveur.',
  })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  @MinLength(8)
  @MaxLength(128)
  password?: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class GoogleMobileAuthDto extends ReferralAttributionDto {
  @ApiProperty({ required: false, example: 'ZW7K9M2P4Q' })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9]+$/)
  referralCode?: string;

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

  @ApiProperty({
    description: 'Prenom(s) legaux confirmes pendant la premiere inscription',
    required: false,
  })
  @Transform(toNormalizedLegalName)
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ApiProperty({
    description:
      'Nom legal confirme pendant la premiere inscription (post-nom facultatif)',
    required: false,
  })
  @Transform(toNormalizedLegalName)
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @ApiProperty({
    enum: UserGender,
    enumName: 'UserGender',
    example: UserGender.FEMALE,
    required: false,
    nullable: true,
    description: 'Sexe choisi lors de la premiere inscription Google',
  })
  @IsEnum(UserGender)
  @IsOptional()
  gender?: UserGender | null;

  @ApiProperty({
    enum: SELF_SERVICE_USER_ROLES,
    example: UserRole.PASSENGER,
    required: false,
    description: 'Role choisi pendant la premiere inscription Google',
  })
  @IsIn(SELF_SERVICE_USER_ROLES)
  @IsOptional()
  role?: UserRole;

  @ApiProperty({
    required: false,
    example: false,
    description: 'Indique si utilisateur est conducteur',
  })
  @IsBoolean()
  @IsOptional()
  isDriver?: boolean;

  @ApiProperty({
    required: false,
    type: () => CreateVehicleDto,
    description:
      'Infos vehicule pour la premiere inscription Google conducteur',
  })
  @ValidateNested()
  @IsOptional()
  @Type(() => CreateVehicleDto)
  vehicle?: CreateVehicleDto;
}

export class AppleMobileAuthDto extends ReferralAttributionDto {
  @ApiProperty({ required: false, example: 'ZW7K9M2P4Q' })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9]+$/)
  referralCode?: string;

  @ApiProperty({
    description: 'Apple identity token obtenu cote mobile (Sign in with Apple)',
  })
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @ApiProperty({
    description: 'Nonce envoye a Apple au moment de la demande, si utilise',
    required: false,
  })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  nonce?: string;

  @ApiProperty({
    description: 'Numero de telephone requis au premier login Apple',
    example: '+243900000000',
    required: false,
  })
  @Transform(toTrimmedString)
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({
    description:
      'Prenom fourni par Apple uniquement lors de la premiere autorisation',
    required: false,
  })
  @Transform(toNormalizedLegalName)
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ApiProperty({
    description:
      'Nom fourni par Apple uniquement lors de la premiere autorisation',
    required: false,
  })
  @Transform(toNormalizedLegalName)
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @ApiProperty({
    enum: UserGender,
    enumName: 'UserGender',
    example: UserGender.FEMALE,
    required: false,
    nullable: true,
    description: 'Sexe choisi lors de la premiere inscription Apple',
  })
  @IsEnum(UserGender)
  @IsOptional()
  gender?: UserGender | null;

  @ApiProperty({
    enum: SELF_SERVICE_USER_ROLES,
    example: UserRole.PASSENGER,
    required: false,
    description: 'Role choisi pendant la premiere inscription Apple',
  })
  @IsIn(SELF_SERVICE_USER_ROLES)
  @IsOptional()
  role?: UserRole;

  @ApiProperty({
    required: false,
    example: false,
    description: 'Indique si utilisateur est conducteur',
  })
  @IsBoolean()
  @IsOptional()
  isDriver?: boolean;

  @ApiProperty({
    required: false,
    type: () => CreateVehicleDto,
    description: 'Infos vehicule pour la premiere inscription Apple conducteur',
  })
  @ValidateNested()
  @IsOptional()
  @Type(() => CreateVehicleDto)
  vehicle?: CreateVehicleDto;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiProperty({ required: false })
  passwordChangeRequired?: boolean;
}
