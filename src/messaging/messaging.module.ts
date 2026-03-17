import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MessagingService } from './messaging.service';

@Module({
  imports: [HttpModule],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}

