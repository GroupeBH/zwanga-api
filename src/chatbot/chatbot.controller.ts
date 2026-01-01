import {
  Controller,
  Post,
  Body,
  Request,
  HttpCode,
  HttpStatus,
  Delete,
  Param,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ChatbotService } from './chatbot.service';
import { ChatbotMessageDto, ChatbotResponseDto } from './dto/chatbot.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Chatbot')
@Controller('chatbot')
export class ChatbotController {
  constructor(private readonly chatbotService: ChatbotService) {}

  @Post('chat')
  @Public() // Permettre l'accès sans authentification pour faciliter l'utilisation
  @HttpCode(HttpStatus.OK)
  @SensitiveThrottle(20, 60000) // 20 requêtes par minute
  @ApiOperation({
    summary: 'Envoyer un message au chatbot',
    description: 'Permet d\'interagir avec le chatbot intelligent basé sur LangChain et Ollama',
  })
  @ApiResponse({
    status: 200,
    description: 'Réponse du chatbot',
    type: ChatbotResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Erreur de validation ou service indisponible',
  })
  async chat(
    @Body() dto: ChatbotMessageDto,
    @Request() req?: any,
  ): Promise<ChatbotResponseDto> {
    // Utiliser l'ID utilisateur si authentifié, sinon générer un ID temporaire
    const userId = req?.user?.userId || `anonymous-${Date.now()}`;
    return this.chatbotService.chat(userId, dto);
  }

  @Post('chat/authenticated')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @SensitiveThrottle(30, 60000) // 30 requêtes par minute pour les utilisateurs authentifiés
  @ApiOperation({
    summary: 'Envoyer un message au chatbot (utilisateur authentifié)',
    description: 'Version authentifiée du chatbot avec historique de conversation',
  })
  @ApiResponse({
    status: 200,
    description: 'Réponse du chatbot',
    type: ChatbotResponseDto,
  })
  async chatAuthenticated(
    @Body() dto: ChatbotMessageDto,
    @Request() req: any,
  ): Promise<ChatbotResponseDto> {
    return this.chatbotService.chat(req.user.userId, dto);
  }

  @Delete('conversation/:conversationId')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Supprimer l\'historique d\'une conversation',
    description: 'Nettoie l\'historique de conversation pour libérer la mémoire',
  })
  @ApiResponse({
    status: 204,
    description: 'Historique supprimé avec succès',
  })
  async clearConversation(@Param('conversationId') conversationId: string): Promise<void> {
    this.chatbotService.clearConversationHistory(conversationId);
  }
}

