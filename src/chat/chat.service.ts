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
import { Conversation } from './entities/conversation.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { User } from '../users/entities/user.entity';
import {
  CreateConversationDto,
  ListConversationsQueryDto,
} from './dto/conversation.dto';

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

  async getConversation(userId: string, conversationId: string) {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: ['participants', 'participants.user'],
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    this.ensureMembership(conversation.participants, userId);

    return this.enrichConversation(conversation, userId);
  }

  async getConversationMessages(conversationId: string, userId: string) {
    await this.ensureUserInConversation(conversationId, userId);

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

    return this.messageRepository.findOne({
      where: { id: savedMessage.id },
      relations: ['sender'],
    });
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
      participants: conversation.participants.map((participant) => ({
        id: participant.id,
        userId: participant.userId,
        user: participant.user
          ? {
              id: participant.user.id,
              firstName: participant.user.firstName,
              lastName: participant.user.lastName,
              profilePicture: participant.user.profilePicture,
            }
          : null,
        lastReadAt: participant.lastReadAt,
        isMuted: participant.isMuted,
      })),
      lastMessage,
      unreadCount,
    };
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
}
