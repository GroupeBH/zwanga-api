import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChatbotMessageDto {
  @ApiProperty({
    example: 'Comment réserver un trajet ?',
    description: 'Message de l\'utilisateur au chatbot',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000, { message: 'Le message ne peut pas dépasser 1000 caractères' })
  message: string;

  @ApiProperty({
    required: false,
    example: 'conversation-id-123',
    description: 'ID de la conversation pour maintenir le contexte',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;
}

export class ChatbotResponseDto {
  @ApiProperty({ example: 'Pour réserver un trajet, vous devez...' })
  response: string;

  @ApiProperty({ example: 'conversation-id-123' })
  conversationId: string;

  @ApiProperty({ example: ['faq-1', 'faq-2'], required: false })
  relatedFaqs?: string[];
}

