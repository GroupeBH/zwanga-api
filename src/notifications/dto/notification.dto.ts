import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID, ArrayMinSize } from 'class-validator';

export class MarkNotificationsAsReadDto {
  @ApiProperty({
    description: 'IDs des notifications à marquer comme lues',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Au moins une notification doit être sélectionnée' })
  @IsUUID(undefined, { each: true, message: 'Chaque ID de notification doit être un UUID valide' })
  notificationIds: string[];
}

