import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatService } from '../chat/chat.service';
import {
  CreateSupportConversationDto,
  ListConversationsQueryDto,
  SendMessageDto,
} from '../chat/dto/conversation.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

@ApiTags('Support')
@Controller('support')
export class SupportController {
  constructor(private readonly chatService: ChatService) {}

  @Post('conversations')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Créer une conversation avec le support' })
  async createConversation(
    @Request() req,
    @Body() dto: CreateSupportConversationDto,
  ) {
    return this.chatService.createSupportConversation(req.user.userId, dto);
  }

  @Get('conversations')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Lister les conversations de support' })
  async listConversations(
    @Request() req,
    @Query() query: ListConversationsQueryDto,
  ) {
    return this.chatService.listSupportConversations(req.user.userId, query);
  }

  @Get('conversations/:id')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Obtenir une conversation de support' })
  async getConversation(@Request() req, @Param('id') id: string) {
    return this.chatService.getSupportConversation(req.user.userId, id);
  }

  @Get('conversations/:id/messages')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Lister les messages d’une conversation de support' })
  async getMessages(@Request() req, @Param('id') id: string) {
    return this.chatService.getSupportConversationMessages(id, req.user.userId);
  }

  @Post('conversations/:id/messages')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Envoyer un message au support' })
  async sendMessage(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendSupportMessage(id, req.user.userId, dto);
  }
}

