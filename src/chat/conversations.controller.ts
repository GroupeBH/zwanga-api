import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Patch,
  Query,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import {
  AddParticipantsDto,
  CreateConversationDto,
  ListConversationsQueryDto,
  SendMessageDto,
} from './dto/conversation.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('Conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Créer une conversation' })
  async create(@Request() req, @Body() dto: CreateConversationDto) {
    return this.chatService.createConversation(req.user.userId, dto);
  }

  @Get()
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Lister les conversations' })
  async list(
    @Request() req,
    @Query() query: ListConversationsQueryDto,
  ) {
    return this.chatService.listConversations(req.user.userId, query);
  }

  @Get(':id')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Récupérer une conversation' })
  async getConversation(@Request() req, @Param('id') id: string) {
    return this.chatService.getConversation(req.user.userId, id);
  }

  @Get(':id/messages')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Liste des messages d’une conversation' })
  async getMessages(@Request() req, @Param('id') id: string) {
    return this.chatService.getConversationMessages(id, req.user.userId);
  }

  @Post(':id/messages')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Envoyer un message dans une conversation' })
  async sendMessage(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendConversationMessage(
      id,
      req.user.userId,
      dto.content,
    );
  }

  @Post(':id/participants')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Ajouter des participants' })
  async addParticipants(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: AddParticipantsDto,
  ) {
    return this.chatService.addParticipants(
      id,
      req.user.userId,
      dto.userIds,
    );
  }

  @Delete(':id/participants/:userId')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Retirer un participant' })
  async removeParticipant(
    @Request() req,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.chatService.removeParticipant(id, req.user.userId, userId);
    return { message: 'Participant removed' };
  }

  @Post(':id/read')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Marquer la conversation comme lue' })
  async markRead(@Request() req, @Param('id') id: string) {
    await this.chatService.markConversationRead(id, req.user.userId);
    return { message: 'Conversation marked as read' };
  }

  @Delete(':id')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Supprimer une conversation',
    description:
      'Supprime la conversation pour l’utilisateur courant. Si aucun participant ne reste, la conversation et ses messages sont supprimés.',
  })
  async deleteConversation(@Request() req, @Param('id') id: string) {
    await this.chatService.deleteConversationForUser(id, req.user.userId);
    return { message: 'Conversation supprimée avec succès' };
  }

  @Patch('messages/:messageId')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Modifier un message envoyé' })
  async editMessage(
    @Request() req,
    @Param('messageId') messageId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.editMessage(messageId, req.user.userId, dto.content);
  }

  @Delete('messages/:messageId')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Supprimer un message envoyé' })
  async deleteMessage(
    @Request() req,
    @Param('messageId') messageId: string,
  ) {
    await this.chatService.deleteMessage(messageId, req.user.userId);
    return { message: 'Message supprimé avec succès' };
  }
}

