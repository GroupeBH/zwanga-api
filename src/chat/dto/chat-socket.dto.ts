import {
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class BookingChatSocketDto {
  @IsUUID('4')
  bookingId: string;
}

export class SendChatSocketMessageDto extends BookingChatSocketDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'Le message ne peut pas être vide.' })
  @MaxLength(4000)
  content: string;
}
