import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID, ArrayMinSize, ArrayMaxSize } from 'class-validator';

export class SendWhatsAppNotificationDto {
  @ApiProperty({
    description: 'IDs des contacts d\'urgence à notifier (2 à 3 contacts)',
    type: [String],
    minItems: 2,
    maxItems: 3,
  })
  @IsArray()
  @ArrayMinSize(2, { message: 'Vous devez sélectionner au moins 2 contacts d\'urgence' })
  @ArrayMaxSize(3, { message: 'Vous ne pouvez pas sélectionner plus de 3 contacts d\'urgence' })
  @IsUUID(undefined, { each: true, message: 'Chaque ID de contact doit être un UUID valide' })
  emergencyContactIds: string[];
}

