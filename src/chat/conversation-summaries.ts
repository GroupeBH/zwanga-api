import { Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';

export type ConversationSummary = { lastMessage: Message | null; unreadCount: number };
export async function loadConversationSummaries(repository: Repository<Message>, ids: string[], userId: string) {
  const summaries = new Map<string, ConversationSummary>(ids.map(id => [id, { lastMessage: null, unreadCount: 0 }]));
  if (!ids.length) return summaries;
  // Two bounded batch queries, independent of the number of conversations on a page.
  const [lastMessages, unread] = await Promise.all([
    repository.createQueryBuilder('message').distinctOn(['message.conversationId'])
      .leftJoinAndSelect('message.sender', 'sender')
      .where('message.conversationId IN (:...ids)', { ids })
      .orderBy('message.conversationId', 'ASC').addOrderBy('message.createdAt', 'DESC').addOrderBy('message.id', 'DESC').getMany(),
    repository.createQueryBuilder('message')
      .innerJoin(ConversationParticipant, 'membership', 'membership.conversationId = message.conversationId AND membership.userId = :userId', { userId })
      .select('message.conversationId', 'conversationId').addSelect('COUNT(message.id)', 'count')
      .where('message.conversationId IN (:...ids)', { ids }).andWhere('message.senderId != :userId', { userId })
      .andWhere('(membership.lastReadAt IS NULL OR message.createdAt > membership.lastReadAt)')
      .groupBy('message.conversationId').getRawMany<{ conversationId: string; count: string }>(),
  ]);
  for (const message of lastMessages) summaries.get(message.conversationId)!.lastMessage = message;
  for (const row of unread) summaries.get(row.conversationId)!.unreadCount = Number(row.count);
  return summaries;
}
