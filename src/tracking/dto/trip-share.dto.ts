import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTripShareLinkDto {
  @ApiProperty({
    required: false,
    description:
      'Reservation a associer au lien public lorsque le passager partage son propre suivi',
  })
  @IsUUID()
  @IsOptional()
  bookingId?: string;

  @ApiProperty({
    required: false,
    description:
      "Adresse email du proche. Optionnelle si l'utilisateur veut remplir le destinataire dans son client mail.",
    example: 'proche@example.com',
  })
  @IsEmail()
  @MaxLength(160)
  @IsOptional()
  recipientEmail?: string;

  @ApiProperty({
    required: false,
    description: 'Nom du proche a afficher dans le brouillon email',
    example: 'Maman',
  })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  recipientName?: string;

  @ApiProperty({
    required: false,
    description: 'Message personnel ajoute au brouillon email',
    example: 'Voici le lien pour suivre mon trajet.',
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  message?: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 168,
    default: 48,
    description: 'Duree de validite du lien public en heures',
  })
  @IsInt()
  @Min(1)
  @Max(168)
  @IsOptional()
  expiresInHours?: number;
}
