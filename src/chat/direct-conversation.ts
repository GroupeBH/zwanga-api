import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Conversation, ConversationType } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';

/** Resolve under a transaction-scoped pair lock; no inbox download or duplicate on concurrent taps. */
export async function resolveDirectConversation(repository: Repository<Conversation>, creatorId: string, userId: string) {
  if (creatorId === userId) throw new BadRequestException('Choisissez un autre utilisateur.');
  const participants = [creatorId, userId].sort();
  return repository.manager.transaction(async manager => {
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`direct-conversation:${participants.join(':')}`]);
    const conversations = manager.getRepository(Conversation);
    const existing = await conversations.createQueryBuilder('conversation')
      .innerJoin('conversation.participants', 'first', 'first.userId = :creatorId', { creatorId })
      .innerJoin('conversation.participants', 'second', 'second.userId = :userId', { userId })
      .where('conversation.type = :type', { type: ConversationType.GENERAL })
      .andWhere('conversation.bookingId IS NULL')
      .andWhere('NOT EXISTS (SELECT 1 FROM "conversation_participants" "other" WHERE "other"."conversationId" = "conversation"."id" AND "other"."userId" NOT IN (:creatorId, :userId))')
      .orderBy('conversation.updatedAt', 'DESC').addOrderBy('conversation.id', 'DESC').getOne();
    if (existing) return existing;
    const created = await conversations.save(conversations.create({ type: ConversationType.GENERAL }));
    await manager.getRepository(ConversationParticipant).insert(participants.map(id => ({ conversationId: created.id, userId: id })));
    return created;
  });
}
