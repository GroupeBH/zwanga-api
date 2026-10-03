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
import { UseFilters, UseGuards, UsePipes, UseInterceptors } from '@nestjs/common';
import { WsSessionService } from '../common/services/ws-session.service';
import { WsWorkInterceptor } from '../common/ws-work.interceptor';
import {
  BookingChatSocketDto,
  SendChatSocketMessageDto,
} from './dto/chat-socket.dto';
import {
  assertSocketRoomCapacity,
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
@UseInterceptors(WsWorkInterceptor)
@UsePipes(createWsValidationPipe())
@UseFilters(new WsErrorFilter())
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private chatService: ChatService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private readonly sessions: WsSessionService,
  ) {}

  async handleConnection(client: Socket) {
    if (await this.sessions.connect(client, this.jwtService, this.configService)) {
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
    assertSocketRoomCapacity(client, `booking:${data.bookingId}`);
    await client.join(`booking:${data.bookingId}`);
    return { success: true, bookingId: data.bookingId };
  }

  @SubscribeMessage('leave_booking')
  async handleLeaveBooking(@ConnectedSocket() client: Socket, @MessageBody() data: BookingChatSocketDto) {
    await client.leave(`booking:${data.bookingId}`);
    return { success: true };
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
