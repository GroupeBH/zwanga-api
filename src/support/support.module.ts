import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module';
import { FaqModule } from '../faq/faq.module';
import { User } from '../users/entities/user.entity';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { SupportTicket } from './entities/support-ticket.entity';
import { SupportTicketMessage } from './entities/support-ticket-message.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SupportTicket, SupportTicketMessage, User]),
    ChatModule,
    FaqModule,
  ],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}

