import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsDateString,
  IsOptional,
  IsEnum,
  Min,
  Max,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, OmitType } from '@nestjs/swagger';
import { TripPaymentMode } from '../../payments/enums/trip-payment-mode.enum';
import { VehicleType } from '../../vehicles/entities/vehicle.entity';

export class CreateTripRequestDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  departureLocation: string;

  @ApiProperty({
    required: false,
    description: 'Reference ou repere connu pour faciliter la prise en charge',
    example: 'Entree principale, devant la station',
  })
  @IsString()
  @IsOptional()
  departureReference?: string;

  @ApiProperty({
    description: 'Coordonnées du point de départ [longitude, latitude]',
    example: [15.2663, -4.325],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  departureCoordinates?: [number, number];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  arrivalLocation: string;

  @ApiProperty({
    required: false,
    description: "Reference ou repere connu pour faciliter l'arrivee",
    example: 'Portail noir, a cote du supermarche',
  })
  @IsString()
  @IsOptional()
  arrivalReference?: string;

  @ApiProperty({
    description: "Coordonnées du point d'arrivée [longitude, latitude]",
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates?: [number, number];

  @ApiProperty({
    description: 'Date/heure de départ minimum souhaitée',
    example: '2025-12-20T08:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  departureDateMin: string;

  @ApiProperty({
    description: 'Date/heure de départ maximum acceptée (délai)',
    example: '2025-12-20T18:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  departureDateMax: string;

  @ApiProperty({
    required: false,
    default: 1,
    minimum: 1,
    maximum: 2,
    description:
      'Nombre de places nécessaires (optionnel, 1 place par défaut)',
    example: 2,
  })
  @IsNumber()
  @Min(1)
  @Max(2, {
    message:
      'Pour des raisons de sécurité du conducteur, vous ne pouvez pas réserver plus de 2 places par trajet',
  })
  @IsOptional()
  numberOfSeats?: number;

  @ApiProperty({
    required: false,
    minimum: 0,
    description: 'Prix maximum par place accepté (optionnel)',
    example: 5000,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPricePerSeat?: number;

  @ApiProperty({
    required: true,
    enum: VehicleType,
    enumName: 'VehicleType',
    description:
      'Type de véhicule choisi par le passager. Le prix est toujours recalculé côté serveur.',
    example: VehicleType.CAR,
  })
  @IsEnum(VehicleType, {
    message: 'Le type de vehicule selectionne est invalide',
  })
  vehicleType: VehicleType;

  @ApiProperty({
    required: false,
    enum: TripPaymentMode,
    enumName: 'TripPaymentMode',
    description:
      'Mode de reglement: paiement electronique via FlexPay, jetons Zwanga ou paiement physique a l arrivee',
    example: TripPaymentMode.ELECTRONIC,
  })
  @IsEnum(TripPaymentMode, {
    message: 'Le mode de paiement selectionne est invalide',
  })
  @IsOptional()
  paymentMode?: TripPaymentMode;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;
}

export class RecommendTripRequestPriceDto {
  @ApiProperty({
    required: false,
    description:
      'Adresse de depart, utilisee si les coordonnees ne sont pas fournies',
  })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Reference ou repere connu pour faciliter la prise en charge',
  })
  @IsString()
  @IsOptional()
  departureReference?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnees du point de depart [longitude, latitude]',
    example: [15.2663, -4.325],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  departureCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    description:
      'Adresse d arrivee, utilisee si les coordonnees ne sont pas fournies',
  })
  @IsString()
  @IsOptional()
  arrivalLocation?: string;

  @ApiProperty({
    required: false,
    description: "Reference ou repere connu pour faciliter l'arrivee",
  })
  @IsString()
  @IsOptional()
  arrivalReference?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnees du point d arrivee [longitude, latitude]',
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 2,
    description: 'Nombre de passagers pour calculer le total recommande',
    example: 2,
  })
  @IsNumber()
  @Min(1)
  @Max(2)
  @IsOptional()
  numberOfSeats?: number;

  @ApiProperty({
    required: false,
    enum: VehicleType,
    enumName: 'VehicleType',
    default: VehicleType.CAR,
    description:
      'Type de vehicule utilise pour la grille tarifaire: voiture = 500 FC/km, moto = 1000 FC/km',
    example: VehicleType.MOTORCYCLE_TWO_WHEELS,
  })
  @IsEnum(VehicleType, {
    message: 'Le type de vehicule selectionne est invalide',
  })
  @IsOptional()
  vehicleType?: VehicleType;
}

export class TripRequestVehicleOptionsDto extends OmitType(
  RecommendTripRequestPriceDto,
  ['vehicleType'] as const,
) {}

export class CreateDriverOfferDto {
  @ApiProperty({
    description: 'Date/heure de départ proposée par le driver',
    example: '2025-12-20T10:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  proposedDepartureDate: string;

  @ApiProperty({
    minimum: 0,
    description: 'Prix proposé par place',
    example: 4500,
  })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  pricePerSeat: number;

  @ApiProperty({
    minimum: 1,
    description:
      'Nombre de places disponibles. Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.',
    example: 4,
  })
  @IsNumber()
  @Min(1)
  @IsNotEmpty()
  availableSeats: number;

  @ApiProperty({
    required: false,
    description: 'ID du véhicule à utiliser (doit appartenir au driver)',
  })
  @IsString()
  @IsOptional()
  vehicleId?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  message?: string;

  @ApiProperty({
    required: false,
    description:
      'Reference ou repere propose par le conducteur pour la prise en charge',
    example: "Je m'arrete devant la station",
  })
  @IsString()
  @IsOptional()
  departureReference?: string;

  @ApiProperty({
    required: false,
    description:
      'Coordonnees de prise en charge proposees par le conducteur [longitude, latitude]',
    example: [15.2663, -4.325],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  departureCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    description: "Reference ou repere propose par le conducteur pour l'arrivee",
    example: 'Arrivee possible au parking principal',
  })
  @IsString()
  @IsOptional()
  arrivalReference?: string;

  @ApiProperty({
    required: false,
    description:
      "Coordonnees d'arrivee proposees par le conducteur [longitude, latitude]",
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates?: [number, number];
}

export class AcceptDriverOfferDto {
  @ApiProperty({
    description: "ID de l'offre du driver à accepter",
  })
  @IsString()
  @IsNotEmpty()
  offerId: string;
}

export class AcceptTripRequestDto {
  @ApiProperty({
    required: false,
    description:
      'ID du véhicule à utiliser (doit appartenir au driver). Si non fourni, le premier véhicule actif sera utilisé.',
  })
  @IsString()
  @IsOptional()
  vehicleId?: string;

  @ApiProperty({
    required: false,
    description:
      'Date/heure de départ proposée. Si non fournie, utilise la date minimum de la demande.',
    example: '2025-12-20T10:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  departureDate?: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    description:
      'Nombre total de places disponibles dans le véhicule. Si non fourni, sera déterminé automatiquement. Doit être au moins égal au nombre de places demandées par le passager. Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.',
    example: 4,
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  totalSeats?: number;

  @ApiProperty({
    required: false,
    description:
      'Reference ou repere ajoute par le conducteur pour la prise en charge',
    example: 'Je vous prends devant la station',
  })
  @IsString()
  @IsOptional()
  departureReference?: string;

  @ApiProperty({
    required: false,
    description:
      'Coordonnees de prise en charge ajoutees par le conducteur [longitude, latitude]',
    example: [15.2663, -4.325],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  departureCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    description: "Reference ou repere ajoute par le conducteur pour l'arrivee",
    example: 'Arrivee au parking principal',
  })
  @IsString()
  @IsOptional()
  arrivalReference?: string;

  @ApiProperty({
    required: false,
    description:
      "Coordonnees d'arrivee ajoutees par le conducteur [longitude, latitude]",
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  arrivalCoordinates?: [number, number];
}

export class UpdateTripRequestDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  departureLocation?: string;

  @ApiProperty({
    required: false,
    description: 'Reference ou repere connu pour faciliter la prise en charge',
  })
  @IsString()
  @IsOptional()
  departureReference?: string;

  @ApiProperty({
    required: false,
    description: 'Coordonnées du point de départ [longitude, latitude]',
    example: [15.2663, -4.325],
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  @IsOptional()
  departureCoordinates?: [number, number];

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  arrivalLocation?: string;

  @ApiProperty({
    required: false,
    description: "Reference ou repere connu pour faciliter l'arrivee",
  })
  @IsString()
  @IsOptional()
  arrivalReference?: string;

  @ApiProperty({
    required: false,
    description: "Coordonnées du point d'arrivée [longitude, latitude]",
    example: [15.3222, -4.4419],
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  @IsOptional()
  arrivalCoordinates?: [number, number];

  @ApiProperty({
    required: false,
    description: 'Date/heure de départ minimum souhaitée',
    example: '2025-12-20T08:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  departureDateMin?: string;

  @ApiProperty({
    required: false,
    description: 'Date/heure de départ maximum acceptée (délai)',
    example: '2025-12-20T18:00:00Z',
  })
  @IsDateString()
  @IsOptional()
  departureDateMax?: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 2,
    description: 'Nombre de places nécessaires',
    example: 2,
  })
  @IsNumber()
  @Min(1)
  @Max(2, {
    message:
      'Pour des raisons de sécurité du conducteur, vous ne pouvez pas réserver plus de 2 places par trajet',
  })
  @IsOptional()
  numberOfSeats?: number;

  @ApiProperty({
    required: false,
    minimum: 0,
    description: 'Prix maximum par place accepté (optionnel)',
    example: 5000,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  maxPricePerSeat?: number;

  @ApiProperty({
    required: false,
    enum: VehicleType,
    enumName: 'VehicleType',
    description:
      'Type de vehicule a utiliser si le backend doit recalculer le prix recommande: voiture = 500 FC/km, moto = 1000 FC/km',
    example: VehicleType.CAR,
  })
  @IsEnum(VehicleType, {
    message: 'Le type de vehicule selectionne est invalide',
  })
  @IsOptional()
  vehicleType?: VehicleType;

  @ApiProperty({
    required: false,
    enum: TripPaymentMode,
    enumName: 'TripPaymentMode',
    description:
      'Mode de reglement: paiement electronique via FlexPay, jetons Zwanga ou paiement physique a l arrivee',
    example: TripPaymentMode.ELECTRONIC,
  })
  @IsEnum(TripPaymentMode, {
    message: 'Le mode de paiement selectionne est invalide',
  })
  @IsOptional()
  paymentMode?: TripPaymentMode;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;
}
