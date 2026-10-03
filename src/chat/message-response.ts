import { Message } from './entities/message.entity';

// Explicit transport boundary: never serialize a User entity, even if loaded by a relation.
export function messageResponse(message: Message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    bookingId: message.bookingId,
    senderId: message.senderId,
    content: message.content,
    isRead: message.isRead,
    readAt: message.readAt,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...(message.sender ? { sender: {
      id: message.sender.id,
      firstName: message.sender.firstName,
      lastName: message.sender.lastName,
      profilePicture: message.sender.profilePicture,
    } } : {}),
  };
}
