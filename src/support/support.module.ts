import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [ChatModule],
  controllers: [SupportController],
})
export class SupportModule {}

