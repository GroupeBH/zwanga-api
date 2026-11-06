import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class WithdrawRequestDriverDto {
  @ApiProperty({ description: 'selectedAt de la commande affichée, inchangé. Protège une nouvelle affectation.' })
  @IsDateString({ strict: true })
  selectedAt: string;
}
