import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { Message } from './entities/message.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { User } from '../users/entities/user.entity';
import { ConversationsController } from './conversations.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Message,
      Booking,
      Conversation,
      ConversationParticipant,
      User,
    ]),
    JwtModule,
    ConfigModule,
    NotificationsModule,
  ],
  controllers: [ChatController, ConversationsController],
  providers: [ChatService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}

