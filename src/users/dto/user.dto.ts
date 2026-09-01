import {
  IsBoolean,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsEnum,
  IsIn,
  MinLength,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { UserGender, UserRole } from '../entities/user.entity';
import { SELF_SERVICE_USER_ROLES } from '../user-role.policy';
import { VehicleType } from '../../vehicles/entities/vehicle.entity';

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
    enum: SELF_SERVICE_USER_ROLES,
  })
  @IsIn(SELF_SERVICE_USER_ROLES)
  @IsOptional()
  role?: UserRole;
}

export class UploadKycDto {
  @ApiProperty({
    required: false,
    description: 'Numéro de document ou référence',
  })
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
    description:
      'Contexte de la vérification : registration (inscription), login (connexion), ou update (mise à jour)',
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
      if (
        Object.values(PhoneVerificationContext).includes(
          normalized as PhoneVerificationContext,
        )
      ) {
        return normalized;
      }
    }
    return value;
  })
  @IsNotEmpty({ message: 'context should not be empty' })
  @IsEnum(PhoneVerificationContext, {
    message:
      'context must be one of the following values: registration, login, update',
  })
  context: PhoneVerificationContext;
}

export class PublicUserInfoDto {
  @ApiProperty({ description: "ID de l'utilisateur" })
  id: string;

  @ApiProperty({ description: 'Prénom' })
  firstName: string;

  @ApiProperty({ description: 'Nom' })
  lastName: string;

  @ApiProperty({ description: 'Photo de profil', nullable: true })
  profilePicture: string | null;

  @ApiProperty({ description: "Rôle de l'utilisateur", enum: UserRole })
  role: UserRole;

  @ApiProperty({ description: "Indique si l'utilisateur est conducteur" })
  isDriver: boolean;

  @ApiProperty({
    description: 'Indique si le conducteur a un abonnement premium actif',
  })
  isPremium: boolean;

  @ApiProperty({ description: 'Indique si le badge premium doit etre affiche' })
  premiumBadge: boolean;

  @ApiProperty({ description: "Statut de l'utilisateur" })
  status: string;

  @ApiProperty({ description: "Indique si l'email est vérifié" })
  isEmailVerified: boolean;

  @ApiProperty({ description: 'Indique si le téléphone est vérifié' })
  isPhoneVerified: boolean;

  @ApiProperty({ description: 'Date de création du compte' })
  createdAt: Date;

  @ApiProperty({ description: "Note moyenne de l'utilisateur", nullable: true })
  averageRating: number | null;

  @ApiProperty({ description: 'Nombre total de notes reçues' })
  totalRatings: number;

  @ApiProperty({ description: "Statistiques de l'utilisateur" })
  stats: {
    tripsAsDriver: number;
    bookingsAsPassenger: number;
    bookingsAsDriver: number;
    vehiclesCount: number;
  };

  @ApiProperty({
    description: 'Véhicules du conducteur (si driver)',
    nullable: true,
    type: 'array',
  })
  vehicles?: Array<{
    id: string;
    type: VehicleType;
    brand: string;
    model: string;
    color: string;
    licensePlate: string;
    photoUrl: string | null;
  }>;
}

export class ChangePinDto {
  @ApiProperty({
    required: false,
    example: '1234',
    description: 'Ancien PIN (4 chiffres) - optionnel si oublié',
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
