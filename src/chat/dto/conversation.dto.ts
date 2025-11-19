import {
  IsArray,
  ArrayMinSize,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateConversationDto {
  @ApiProperty({
    type: [String],
    description: 'Liste des participants (IDs utilisateurs)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  participantIds: string[];

  @ApiProperty({ required: false, description: 'Titre de la conversation' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({
    required: false,
    description: 'Associer à une réservation existante',
  })
  @IsUUID()
  @IsOptional()
  bookingId?: string;

  @ApiProperty({
    required: false,
    description: 'Premier message à envoyer',
  })
  @IsString()
  @IsOptional()
  initialMessage?: string;
}

export class ListConversationsQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  limit?: number = 20;
}

export class SendMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class AddParticipantsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  userIds: string[];
}

