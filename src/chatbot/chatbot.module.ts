import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatbotService } from './chatbot.service';
import { ChatbotController } from './chatbot.controller';
import { FaqModule } from '../faq/faq.module';

@Module({
  imports: [ConfigModule, FaqModule],
  controllers: [ChatbotController],
  providers: [ChatbotService],
  exports: [ChatbotService],
})
export class ChatbotModule {}

