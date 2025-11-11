import { Controller, Get, Param, Request, Put } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { Auth } from '../auth/decorators/auth.decorator';

@ApiTags('Chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('booking/:bookingId/messages')
  @Auth()
  @ApiOperation({ summary: 'Get messages for a booking' })
  async getMessages(@Request() req, @Param('bookingId') bookingId: string) {
    return this.chatService.getMessages(bookingId, req.user.userId);
  }

  @Put('messages/:messageId/read')
  @Auth()
  @ApiOperation({ summary: 'Mark a message as read' })
  async markAsRead(@Request() req, @Param('messageId') messageId: string) {
    await this.chatService.markAsRead(messageId, req.user.userId);
    return { message: 'Message marked as read' };
  }
}

