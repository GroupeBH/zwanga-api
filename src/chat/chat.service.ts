import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, MoreThan, Not, FindOptionsWhere } from 'typeorm';
import { Message } from './entities/message.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Conversation, ConversationType } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { ADMIN_USER_ROLES } from '../users/user-role.policy';
import {
  CreateConversationDto,
  ListConversationsQueryDto,
  CreateSupportConversationDto,
  SendMessageDto,
} from './dto/conversation.dto';
import { NotificationService } from '../notifications/notifications.service';
import { FileUploadService } from '../common/services/file-upload.service';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participantRepository: Repository<ConversationParticipant>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly notificationService: NotificationService,
    private readonly fileUploadService: FileUploadService,
  ) {}

  /* -------------------------------------------------------------------------- */
  /*                                Conversation                                */
  /* -------------------------------------------------------------------------- */

  async createConversation(
    creatorId: string,
    dto: CreateConversationDto,
  ) {
    const participantIds = Array.from(
      new Set([creatorId, ...dto.participantIds]),
    );

    let conversation: Conversation | null = null;

    if (dto.bookingId) {
      conversation = await this.findOrCreateConversationForBooking(
        dto.bookingId,
      );
      await this.ensureParticipants(conversation.id, participantIds);
    } else {
      await this.ensureUsersExist(participantIds);
      conversation = this.conversationRepository.create({
        title: dto.title,
        type: ConversationType.GENERAL,
      });
      conversation = await this.conversationRepository.save(conversation);
      await this.ensureParticipants(conversation.id, participantIds);
    }

    if (dto.initialMessage) {
      await this.sendConversationMessage(
        conversation.id,
        creatorId,
        dto.initialMessage,
      );
    }

    return this.getConversation(creatorId, conversation.id);
  }

  async listConversations(
    userId: string,
    query: ListConversationsQueryDto,
    options?: { type?: ConversationType },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const qb = this.conversationRepository
      .createQueryBuilder('conversation')
      .innerJoin(
        'conversation.participants',
        'membership',
        'membership.userId = :userId',
        { userId },
      )
      .leftJoinAndSelect('conversation.participants', 'participants')
      .leftJoinAndSelect('participants.user', 'participantUser')
      .orderBy('conversation.updatedAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (options?.type) {
      qb.andWhere('conversation.type = :type', { type: options.type });
    }

    const [conversations, total] = await qb.getManyAndCount();

    const data = await Promise.all(
      conversations.map((conversation) =>
        this.enrichConversation(conversation, userId),
      ),
    );

    return {
      data,
      meta: {
        page,
        limit,
        total,
      },
    };
  }

  async getConversation(
    userId: string,
    conversationId: string,
    expectedType?: ConversationType,
  ) {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['participants', 'participants.user'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    this.ensureMembership(conversation.participants, userId);
    this.ensureConversationType(conversation, expectedType);

    return this.enrichConversation(conversation, userId);
  }

  async getConversationMessages(
    conversationId: string,
    userId: string,
    expectedType?: ConversationType,
  ) {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['participants'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    this.ensureMembership(conversation.participants, userId);
    this.ensureConversationType(conversation, expectedType);

    const messages = await this.messageRepository.find({
      where: { conversationId },
      relations: ['sender'],
      order: { createdAt: 'ASC' },
    });

    return messages;
  }

  async sendConversationMessage(
    conversationId: string,
    senderId: string,
    content: string,
  ): Promise<Message | null> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['participants'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    this.ensureMembership(conversation.participants, senderId);

    const message = this.messageRepository.create({
      conversationId,
      bookingId: conversation.bookingId,
      senderId,
      content,
    });

    const savedMessage = await this.messageRepository.save(message);

    await this.conversationRepository.update(conversationId, {
      lastMessageAt: savedMessage.createdAt,
    });

    await this.participantRepository.update(
      { conversationId, userId: senderId },
      { lastReadAt: savedMessage.createdAt },
    );

    const populatedMessage = await this.messageRepository.findOne({
      where: { id: savedMessage.id },
      relations: ['sender'],
    });

    if (populatedMessage) {
      await this.notifyConversationParticipants(conversation, populatedMessage);
    }

    return populatedMessage;
  }

  async addParticipants(
    conversationId: string,
    requestUserId: string,
    userIds: string[],
  ) {
    await this.ensureUserInConversation(conversationId, requestUserId);
    await this.ensureUsersExist(userIds);
    await this.ensureParticipants(conversationId, userIds);
    return this.getConversation(requestUserId, conversationId);
  }

  async removeParticipant(
    conversationId: string,
    requestUserId: string,
    userIdToRemove: string,
  ) {
    await this.ensureUserInConversation(conversationId, requestUserId);

    const participant = await this.participantRepository.findOne({
      where: { conversationId, userId: userIdToRemove },
    });

    if (!participant) {
      throw new NotFoundException('Participant not found');
    }

    await this.participantRepository.remove(participant);
  }

  async markConversationRead(conversationId: string, userId: string) {
    await this.participantRepository.update(
      { conversationId, userId },
      { lastReadAt: new Date() },
    );
  }

  /**
   * Delete a conversation for the current user.
   * - Seul l'utilisateur courant est retiré des participants (il ne verra plus la conversation).
   * - La conversation, les autres participants et les messages restent en base.
   */
  async deleteConversationForUser(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['participants'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    // Ensure the user is part of this conversation
    this.ensureMembership(conversation.participants, userId);

    // Remove the participant (soft delete for this user)
    const participant = conversation.participants.find(
      (p) => p.userId === userId,
    );

    if (participant) {
      await this.participantRepository.remove(participant);
    }

    this.logger.log(
      `User ${userId} removed from conversation ${conversationId}; conversation and messages kept for other participants`,
    );
  }

  /* -------------------------------------------------------------------------- */
  /*                          Booking-specific helpers                          */
  /* -------------------------------------------------------------------------- */

  async ensureConversationForBooking(bookingId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip', 'trip.driver', 'passenger'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return this.findOrCreateConversationForBooking(booking.id, booking);
  }

  async createMessage(
    bookingId: string,
    senderId: string,
    content: string,
  ): Promise<Message | null> {
    const conversation = await this.ensureConversationForBooking(bookingId);

    return this.sendConversationMessage(conversation.id, senderId, content);
  }

  async getMessages(bookingId: string, userId: string): Promise<Message[]> {
    const conversation = await this.ensureConversationForBooking(bookingId);
    return this.getConversationMessages(conversation.id, userId);
  }

  async markAsRead(messageId: string, userId: string): Promise<void> {
    const message = await this.messageRepository.findOne({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    await this.markConversationRead(message.conversationId, userId);
  }

  async editMessage(
    messageId: string,
    userId: string,
    newContent: string,
  ): Promise<Message> {
    const message = await this.messageRepository.findOne({
      where: { id: messageId },
      relations: ['conversation'],
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.senderId !== userId) {
      throw new ForbiddenException('Vous ne pouvez modifier que vos propres messages');
    }

    if (!newContent || newContent.trim().length === 0) {
      throw new BadRequestException('Le contenu du message ne peut pas être vide');
    }

    message.content = newContent;
    const updated = await this.messageRepository.save(message);

    return updated;
  }

  async deleteMessage(
    messageId: string,
    userId: string,
  ): Promise<void> {
    const message = await this.messageRepository.findOne({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.senderId !== userId) {
      throw new ForbiddenException('Vous ne pouvez supprimer que vos propres messages');
    }

    await this.messageRepository.delete(messageId);
  }

  /* -------------------------------------------------------------------------- */
  /*                                Private bits                                */
  /* -------------------------------------------------------------------------- */

  private async enrichConversation(conversation: Conversation, userId: string) {
    const lastMessage = await this.messageRepository.findOne({
      where: { conversationId: conversation.id },
      relations: ['sender'],
      order: { createdAt: 'DESC' },
    });

    const membership = conversation.participants.find(
      (participant) => participant.userId === userId,
    );

    const lastReadAt = membership?.lastReadAt ?? null;

    const unreadWhere: FindOptionsWhere<Message> = {
      conversationId: conversation.id,
      senderId: Not(userId),
    };

    if (lastReadAt) {
      unreadWhere.createdAt = MoreThan(lastReadAt);
    }

    const unreadCount = await this.messageRepository.count({
      where: unreadWhere,
    });

    return {
      ...conversation,
      participants: await Promise.all(
        conversation.participants.map(async (participant) => {
          let profilePicture = participant.user?.profilePicture || null;
          if (profilePicture) {
            profilePicture = await this.fileUploadService.getPresignedUrlIfS3Key(profilePicture) || profilePicture;
          }
          return {
            id: participant.id,
            userId: participant.userId,
            user: participant.user
              ? {
                  id: participant.user.id,
                  firstName: participant.user.firstName,
                  lastName: participant.user.lastName,
                  profilePicture,
                }
              : null,
            lastReadAt: participant.lastReadAt,
            isMuted: participant.isMuted,
          };
        }),
      ),
      lastMessage,
      unreadCount,
    };
  }

  async createSupportConversation(
    userId: string,
    dto: CreateSupportConversationDto,
  ) {
    const supportAgents = await this.getSupportAgents();

    if (supportAgents.length === 0) {
      throw new BadRequestException(
        'Support indisponible pour le moment. Veuillez réessayer plus tard.',
      );
    }

    const conversation = this.conversationRepository.create({
      title: dto.subject || 'Support',
      type: ConversationType.SUPPORT,
    });

    const savedConversation = await this.conversationRepository.save(
      conversation,
    );

    const participantIds = Array.from(
      new Set([userId, ...supportAgents.map((agent) => agent.id)]),
    );

    await this.ensureParticipants(savedConversation.id, participantIds);

    if (dto.message) {
      await this.sendConversationMessage(
        savedConversation.id,
        userId,
        dto.message,
      );
    }

    return this.getConversation(
      userId,
      savedConversation.id,
      ConversationType.SUPPORT,
    );
  }

  async listSupportConversations(
    userId: string,
    query: ListConversationsQueryDto,
  ) {
    return this.listConversations(userId, query, {
      type: ConversationType.SUPPORT,
    });
  }

  async getSupportConversation(userId: string, conversationId: string) {
    return this.getConversation(
      userId,
      conversationId,
      ConversationType.SUPPORT,
    );
  }

  async getSupportConversationMessages(
    conversationId: string,
    userId: string,
  ) {
    return this.getConversationMessages(
      conversationId,
      userId,
      ConversationType.SUPPORT,
    );
  }

  async sendSupportMessage(
    conversationId: string,
    userId: string,
    dto: SendMessageDto,
  ) {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    this.ensureConversationType(conversation, ConversationType.SUPPORT);
    await this.ensureUserInConversation(conversationId, userId);

    return this.sendConversationMessage(conversationId, userId, dto.content);
  }

  private async ensureParticipants(conversationId: string, userIds: string[]) {
    if (userIds.length === 0) {
      return;
    }

    await this.ensureUsersExist(userIds);

    const existing = await this.participantRepository.find({
      where: {
        conversationId,
        userId: In(userIds),
      },
    });

    const existingIds = new Set(existing.map((p) => p.userId));
    const toInsert = userIds.filter((id) => !existingIds.has(id));

    const entities = toInsert.map((userId) =>
      this.participantRepository.create({
        conversationId,
        userId,
        joinedAt: new Date(),
      }),
    );

    if (entities.length > 0) {
      await this.participantRepository.save(entities);
    }
  }

  private async ensureUsersExist(userIds: string[]) {
    const unique = Array.from(new Set(userIds));
    if (unique.length === 0) {
      return;
    }

    const found = await this.userRepository.find({
      where: { id: In(unique) },
    });

    if (found.length !== unique.length) {
      throw new NotFoundException('One or more users not found');
    }
  }

  private ensureMembership(
    participants: ConversationParticipant[],
    userId: string,
  ) {
    if (!participants.some((participant) => participant.userId === userId)) {
      throw new ForbiddenException('User not part of this conversation');
    }
  }

  private async ensureUserInConversation(
    conversationId: string,
    userId: string,
  ) {
    const participant = await this.participantRepository.findOne({
      where: { conversationId, userId },
    });

    if (!participant) {
      throw new ForbiddenException('User not part of this conversation');
    }
  }

  private async findOrCreateConversationForBooking(
    bookingId: string,
    bookingRecord?: Booking,
  ) {
    let conversation = await this.conversationRepository.findOne({
      where: { bookingId },
      relations: ['participants'],
    });

    const booking =
      bookingRecord ||
      (await this.bookingRepository.findOne({
        where: { id: bookingId },
        relations: ['trip', 'trip.driver', 'passenger'],
      }));

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (!conversation) {
      conversation = this.conversationRepository.create({
        bookingId: booking.id,
        title: `Trajet ${booking.trip.departureLocation} -> ${booking.trip.arrivalLocation}`,
        lastMessageAt: new Date(),
        type: ConversationType.BOOKING,
      });
      conversation = await this.conversationRepository.save(conversation);
      conversation.participants = [];
    }

    await this.ensureParticipants(conversation.id, [
      booking.trip.driverId,
      booking.passengerId,
    ]);

    return conversation;
  }

  private async getSupportAgents(): Promise<User[]> {
    return this.userRepository.find({
      where: { role: In([...ADMIN_USER_ROLES]) },
      select: ['id', 'firstName', 'lastName', 'fcmToken'],
    });
  }

  private ensureConversationType(
    conversation: Conversation,
    expectedType?: ConversationType,
  ) {
    if (expectedType && conversation.type !== expectedType) {
      throw new BadRequestException('Invalid conversation type');
    }
  }

  private async notifyConversationParticipants(
    conversation: Conversation,
    message: Message,
  ) {
    try {
      const participants = await this.participantRepository.find({
        where: { conversationId: conversation.id },
        relations: ['user'],
      });

      const tokens = Array.from(
        new Set(
          participants
            .filter(
              (participant) =>
                participant.userId !== message.senderId &&
                participant.user?.fcmToken,
            )
            .map((participant) => participant.user!.fcmToken as string),
        ),
      );

      if (tokens.length === 0) {
        return;
      }

      const senderName = message.sender
        ? `${message.sender.firstName ?? ''} ${message.sender.lastName ?? ''}`.trim() ||
          'Un utilisateur'
        : 'Un utilisateur';

      const title =
        conversation.title ||
        (conversation.bookingId ? 'Discussion de trajet' : 'Nouveau message');

      const snippet =
        message.content.length > 80
          ? `${message.content.slice(0, 80)}…`
          : message.content;

      const body = `${senderName}: ${snippet}`;

      const data = {
        conversationId: conversation.id,
        messageId: message.id,
        bookingId: conversation.bookingId ?? '',
      };

      if (tokens.length === 1) {
        const recipient = participants.find(
          (p) => p.userId !== message.senderId && p.user?.fcmToken === tokens[0],
        );
        await this.notificationService.sendNotification(
          tokens[0],
          title,
          body,
          data,
          recipient?.userId,
        );
      } else {
        const recipientIds = participants
          .filter(
            (p) =>
              p.userId !== message.senderId &&
              p.user?.fcmToken &&
              tokens.includes(p.user.fcmToken),
          )
          .map((p) => p.userId);
        await this.notificationService.sendToMultiple(
          tokens,
          title,
          body,
          data,
          recipientIds,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to send message notification: ${error.message}`,
        error.stack,
      );
    }
  }
}
