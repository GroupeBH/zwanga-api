import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import {
  BookingChatSocketDto,
  SendChatSocketMessageDto,
} from './dto/chat-socket.dto';
import {
  authenticateSocket,
  createWsValidationPipe,
  emitSocketError,
  socketUserId,
  WsAuthenticatedGuard,
  WsErrorFilter,
} from '../common/websocket-security';

@WebSocketGateway({
  namespace: '/chat',
})
@UseGuards(new WsAuthenticatedGuard())
@UsePipes(createWsValidationPipe())
@UseFilters(new WsErrorFilter())
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private chatService: ChatService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    if (await authenticateSocket(client, this.jwtService, this.configService)) {
      await client.join(`user:${socketUserId(client)}`);
    }
  }

  handleDisconnect(client: Socket) {
    // Handle disconnect
  }

  @SubscribeMessage('join_booking')
  async handleJoinBooking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: BookingChatSocketDto,
  ) {
    await this.chatService.ensureUserCanAccessBookingChat(
      data.bookingId,
      socketUserId(client),
    );
    await client.join(`booking:${data.bookingId}`);
    return { success: true, bookingId: data.bookingId };
  }

  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SendChatSocketMessageDto,
  ) {
    try {
      const message = await this.chatService.createMessage(
        data.bookingId,
        socketUserId(client),
        data.content,
      );

      // Emit to all clients in the booking room
      this.server.to(`booking:${data.bookingId}`).emit('new_message', message);
    } catch (error) {
      emitSocketError(client, error);
    }
  }

  @SubscribeMessage('get_messages')
  async handleGetMessages(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: BookingChatSocketDto,
  ) {
    try {
      const messages = await this.chatService.getMessages(
        data.bookingId,
        socketUserId(client),
      );
      client.emit('messages', messages);
    } catch (error) {
      emitSocketError(client, error);
    }
  }
}
