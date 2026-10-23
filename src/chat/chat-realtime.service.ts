import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { messageResponse } from './message-response';

/** /chat already authenticates and joins server-owned user rooms. Never trust a
 * client-supplied recipient or an old booking room membership for message delivery. */
@Injectable()
export class ChatRealtime {
  private server?: Server;
  private readonly logger = new Logger(ChatRealtime.name);
  bind(server: Server) { this.server = server; }
  publish(userIds: string[], message: ReturnType<typeof messageResponse>) {
    const rooms = [...new Set(userIds.filter(Boolean))].map(id => `user:${id}`);
    if (!this.server || !rooms.length) return false;
    try {
      this.server.to(rooms).emit('new_message', message);
      return true;
    } catch {
      this.logger.warn('Chat realtime delivery unavailable; saved messages remain available over REST.');
      return false;
    }
  }
}
