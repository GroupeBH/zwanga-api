import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsUUID } from 'class-validator';

export class ChangeRequestDriverDto {
  @ApiProperty({
    description:
      'Identifiant du conducteur actuellement sélectionné (selectedDriver.id).',
  })
  @IsUUID()
  selectedDriverId: string;

  @ApiProperty({
    description:
      'selectedAt renvoyé par la commande, inchangé. Protège contre une action sur une ancienne affectation.',
  })
  @IsDateString({ strict: true })
  selectedAt: string;
}
