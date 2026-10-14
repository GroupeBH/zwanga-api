import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MessagingService } from './messaging.service';

@Module({
  imports: [HttpModule.register({ timeout: 5000, maxRedirects: 0 })],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
