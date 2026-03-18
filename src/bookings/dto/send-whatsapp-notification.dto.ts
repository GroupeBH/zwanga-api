import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID, ArrayMinSize, ArrayMaxSize } from 'class-validator';

export class SendWhatsAppNotificationDto {
  @ApiProperty({
    description: "IDs des contacts d'urgence a notifier (1 a 5 contacts)",
    type: [String],
    minItems: 1,
    maxItems: 5,
  })
  @IsArray()
  @ArrayMinSize(1, { message: "Vous devez selectionner au moins 1 contact d'urgence" })
  @ArrayMaxSize(5, { message: "Vous ne pouvez pas selectionner plus de 5 contacts d'urgence" })
  @IsUUID(undefined, { each: true, message: 'Chaque ID de contact doit etre un UUID valide' })
  emergencyContactIds: string[];
}
