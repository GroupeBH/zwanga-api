import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SelectQueryBuilder, Repository } from 'typeorm';
import { ChatService } from '../chat/chat.service';
import {
  CreateSupportConversationDto,
  ListConversationsQueryDto,
  SendMessageDto,
} from '../chat/dto/conversation.dto';
import { FaqService } from '../faq/faq.service';
import {
  CreateFaqEntryDto,
  ListFaqQueryDto,
  UpdateFaqEntryDto,
} from '../faq/dto/faq.dto';
import { User, UserRole } from '../users/entities/user.entity';
import {
  SupportTicket,
  SupportTicketStatus,
} from './entities/support-ticket.entity';
import { SupportTicketMessage } from './entities/support-ticket-message.entity';
import {
  AddSupportTicketMessageDto,
  AssignSupportTicketDto,
  CreateSupportTicketDto,
  ListAdminSupportTicketsQueryDto,
  ListSupportTicketsQueryDto,
  UpdateSupportTicketStatusDto,
} from './dto/support-ticket.dto';

export interface SanitizedSupportUser {
  id: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}

export interface SanitizedSupportMessage {
  id: string;
  ticketId: string;
  senderId: string;
  content: string;
  isInternal: boolean;
  createdAt: Date;
  sender: SanitizedSupportUser | null;
}

export interface SanitizedSupportTicketSummary {
  id: string;
  userId: string;
  assignedAdminId: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  resolutionSummary: string | null;
  user: SanitizedSupportUser | null;
  assignedAdmin: SanitizedSupportUser | null;
}

export interface SanitizedSupportTicketDetails
  extends SanitizedSupportTicketSummary {
  messages: SanitizedSupportMessage[];
}

@Injectable()
export class SupportService {
  constructor(
    @InjectRepository(SupportTicket)
    private readonly ticketRepository: Repository<SupportTicket>,
    @InjectRepository(SupportTicketMessage)
    private readonly messageRepository: Repository<SupportTicketMessage>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly chatService: ChatService,
    private readonly faqService: FaqService,
  ) {}

  /* -------------------------------------------------------------------------- */
  /*                              Support conversations                         */
  /* -------------------------------------------------------------------------- */

  async createSupportConversation(
    userId: string,
    dto: CreateSupportConversationDto,
  ) {
    return this.chatService.createSupportConversation(userId, dto);
  }

  async listSupportConversations(
    userId: string,
    query: ListConversationsQueryDto,
  ) {
    return this.chatService.listSupportConversations(userId, query);
  }

  async getSupportConversation(userId: string, conversationId: string) {
    return this.chatService.getSupportConversation(userId, conversationId);
  }

  async getSupportConversationMessages(
    conversationId: string,
    userId: string,
  ) {
    return this.chatService.getSupportConversationMessages(conversationId, userId);
  }

  async sendSupportMessage(
    conversationId: string,
    userId: string,
    dto: SendMessageDto,
  ) {
    return this.chatService.sendSupportMessage(conversationId, userId, dto);
  }

  /* -------------------------------------------------------------------------- */
  /*                                     FAQ                                   */
  /* -------------------------------------------------------------------------- */

  async listFaq(query: ListFaqQueryDto) {
    return this.faqService.findAll(query);
  }

  async getFaq(id: string) {
    return this.faqService.findOne(id);
  }

  async createFaq(dto: CreateFaqEntryDto) {
    return this.faqService.create(dto);
  }

  async updateFaq(id: string, dto: UpdateFaqEntryDto) {
    return this.faqService.update(id, dto);
  }

  async removeFaq(id: string) {
    await this.faqService.remove(id);
    return { message: 'FAQ entry removed' };
  }

  /* -------------------------------------------------------------------------- */
  /*                                Support tickets                             */
  /* -------------------------------------------------------------------------- */

  async createTicket(
    userId: string,
    dto: CreateSupportTicketDto,
  ): Promise<SanitizedSupportTicketDetails> {
    const now = new Date();

    const ticket = this.ticketRepository.create({
      userId,
      subject: dto.subject.trim(),
      category: dto.category,
      priority: dto.priority,
      status: SupportTicketStatus.OPEN,
      lastMessageAt: now,
    });

    const savedTicket = await this.ticketRepository.save(ticket);

    const initialMessage = this.messageRepository.create({
      ticketId: savedTicket.id,
      senderId: userId,
      content: dto.message.trim(),
      isInternal: false,
    });

    await this.messageRepository.save(initialMessage);

    return this.getUserTicket(userId, savedTicket.id);
  }

  async listUserTickets(
    userId: string,
    query: ListSupportTicketsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const qb = this.ticketRepository
      .createQueryBuilder('ticket')
      .leftJoinAndSelect('ticket.assignedAdmin', 'assignedAdmin')
      .where('ticket.userId = :userId', { userId })
      .orderBy('ticket.updatedAt', 'DESC')
      .skip(skip)
      .take(limit);

    this.applyCommonTicketFilters(qb, query);

    const [tickets, total] = await qb.getManyAndCount();

    return {
      data: tickets.map((ticket) => this.sanitizeTicketSummary(ticket)),
      meta: {
        page,
        limit,
        total,
      },
    };
  }

  async getUserTicket(
    userId: string,
    ticketId: string,
  ): Promise<SanitizedSupportTicketDetails> {
    const ticket = await this.findTicketWithDetails(ticketId);

    if (ticket.userId !== userId) {
      throw new ForbiddenException('Vous n avez pas accès à ce ticket');
    }

    return this.sanitizeTicketDetails(ticket, false);
  }

  async addUserTicketMessage(
    userId: string,
    ticketId: string,
    dto: AddSupportTicketMessageDto,
  ) {
    return this.addTicketMessage(ticketId, userId, dto, false);
  }

  async closeUserTicket(
    userId: string,
    ticketId: string,
  ): Promise<SanitizedSupportTicketDetails> {
    const ticket = await this.findTicketById(ticketId);

    if (ticket.userId !== userId) {
      throw new ForbiddenException('Vous n avez pas accès à ce ticket');
    }

    if (ticket.status === SupportTicketStatus.CLOSED) {
      return this.getUserTicket(userId, ticket.id);
    }

    ticket.status = SupportTicketStatus.CLOSED;
    ticket.closedAt = new Date();
    ticket.resolvedAt = ticket.resolvedAt ?? ticket.closedAt;
    await this.ticketRepository.save(ticket);

    return this.getUserTicket(userId, ticket.id);
  }

  async reopenUserTicket(
    userId: string,
    ticketId: string,
  ): Promise<SanitizedSupportTicketDetails> {
    const ticket = await this.findTicketById(ticketId);

    if (ticket.userId !== userId) {
      throw new ForbiddenException('Vous n avez pas accès à ce ticket');
    }

    if (
      ticket.status !== SupportTicketStatus.CLOSED &&
      ticket.status !== SupportTicketStatus.RESOLVED
    ) {
      throw new BadRequestException('Ce ticket ne peut pas être rouvert');
    }

    ticket.status = SupportTicketStatus.OPEN;
    ticket.closedAt = null;
    ticket.resolvedAt = null;
    await this.ticketRepository.save(ticket);

    return this.getUserTicket(userId, ticket.id);
  }

  async listAdminTickets(query: ListAdminSupportTicketsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const qb = this.ticketRepository
      .createQueryBuilder('ticket')
      .leftJoinAndSelect('ticket.user', 'user')
      .leftJoinAndSelect('ticket.assignedAdmin', 'assignedAdmin')
      .orderBy('ticket.updatedAt', 'DESC')
      .skip(skip)
      .take(limit);

    this.applyCommonTicketFilters(qb, query);

    if (query.userId) {
      qb.andWhere('ticket.userId = :userId', { userId: query.userId });
    }

    if (query.assignedAdminId) {
      qb.andWhere('ticket.assignedAdminId = :assignedAdminId', {
        assignedAdminId: query.assignedAdminId,
      });
    }

    if (query.unassignedOnly) {
      qb.andWhere('ticket.assignedAdminId IS NULL');
    }

    const [tickets, total] = await qb.getManyAndCount();

    return {
      data: tickets.map((ticket) => this.sanitizeTicketSummary(ticket)),
      meta: {
        page,
        limit,
        total,
      },
    };
  }

  async getAdminTicket(ticketId: string): Promise<SanitizedSupportTicketDetails> {
    const ticket = await this.findTicketWithDetails(ticketId);
    return this.sanitizeTicketDetails(ticket, true);
  }

  async addAdminTicketMessage(
    adminUserId: string,
    ticketId: string,
    dto: AddSupportTicketMessageDto,
  ) {
    await this.ensureAdminUser(adminUserId);
    return this.addTicketMessage(ticketId, adminUserId, dto, true);
  }

  async assignTicket(
    ticketId: string,
    actingAdminId: string,
    dto: AssignSupportTicketDto,
  ) {
    await this.ensureAdminUser(actingAdminId);

    const assignedAdminId = dto.adminId ?? actingAdminId;
    await this.ensureAdminUser(assignedAdminId);

    const ticket = await this.findTicketById(ticketId);
    ticket.assignedAdminId = assignedAdminId;

    if (ticket.status === SupportTicketStatus.OPEN) {
      ticket.status = SupportTicketStatus.IN_PROGRESS;
    }

    await this.ticketRepository.save(ticket);

    return this.getAdminTicket(ticket.id);
  }

  async updateTicketStatus(
    ticketId: string,
    adminUserId: string,
    dto: UpdateSupportTicketStatusDto,
  ) {
    await this.ensureAdminUser(adminUserId);

    const ticket = await this.findTicketById(ticketId);
    ticket.status = dto.status;

    if (dto.resolutionSummary !== undefined) {
      ticket.resolutionSummary = dto.resolutionSummary.trim() || null;
    }

    if (dto.status === SupportTicketStatus.RESOLVED) {
      ticket.resolvedAt = new Date();
      ticket.closedAt = null;
    } else if (dto.status === SupportTicketStatus.CLOSED) {
      ticket.closedAt = new Date();
      ticket.resolvedAt = ticket.resolvedAt ?? ticket.closedAt;
    } else {
      ticket.closedAt = null;
      ticket.resolvedAt = null;
    }

    await this.ticketRepository.save(ticket);

    if (dto.internalNote && dto.internalNote.trim()) {
      const now = new Date();
      const internalNote = this.messageRepository.create({
        ticketId: ticket.id,
        senderId: adminUserId,
        content: dto.internalNote.trim(),
        isInternal: true,
      });

      await this.messageRepository.save(internalNote);
      ticket.lastMessageAt = now;
      await this.ticketRepository.save(ticket);
    }

    return this.getAdminTicket(ticket.id);
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  private applyCommonTicketFilters(
    qb: SelectQueryBuilder<SupportTicket>,
    query: ListSupportTicketsQueryDto,
  ) {
    if (query.status) {
      qb.andWhere('ticket.status = :status', { status: query.status });
    }

    if (query.priority) {
      qb.andWhere('ticket.priority = :priority', { priority: query.priority });
    }

    if (query.category) {
      qb.andWhere('ticket.category = :category', { category: query.category });
    }

    if (query.search) {
      qb.andWhere('ticket.subject ILIKE :search', {
        search: `%${query.search.trim()}%`,
      });
    }
  }

  private async addTicketMessage(
    ticketId: string,
    senderId: string,
    dto: AddSupportTicketMessageDto,
    isAdmin: boolean,
  ) {
    const ticket = await this.findTicketById(ticketId);

    if (!isAdmin && ticket.userId !== senderId) {
      throw new ForbiddenException('Vous n avez pas accès à ce ticket');
    }

    if (!isAdmin && dto.isInternal) {
      throw new ForbiddenException(
        'Les messages internes sont réservés aux admins',
      );
    }

    if (ticket.status === SupportTicketStatus.CLOSED && !isAdmin) {
      throw new BadRequestException(
        'Ce ticket est fermé. Veuillez le rouvrir avant de répondre.',
      );
    }

    const now = new Date();
    const isInternal = isAdmin ? Boolean(dto.isInternal) : false;

    const message = this.messageRepository.create({
      ticketId: ticket.id,
      senderId,
      content: dto.content.trim(),
      isInternal,
    });

    await this.messageRepository.save(message);

    ticket.lastMessageAt = now;

    if (!isInternal) {
      if (isAdmin) {
        if (!ticket.firstResponseAt) {
          ticket.firstResponseAt = now;
        }

        if (
          ticket.status === SupportTicketStatus.OPEN ||
          ticket.status === SupportTicketStatus.WAITING_USER
        ) {
          ticket.status = SupportTicketStatus.IN_PROGRESS;
        }
      } else if (
        ticket.status === SupportTicketStatus.WAITING_USER ||
        ticket.status === SupportTicketStatus.RESOLVED
      ) {
        ticket.status = SupportTicketStatus.OPEN;
        ticket.resolvedAt = null;
        ticket.closedAt = null;
      }
    }

    await this.ticketRepository.save(ticket);

    if (isAdmin) {
      return this.getAdminTicket(ticket.id);
    }

    return this.getUserTicket(senderId, ticket.id);
  }

  private async findTicketById(ticketId: string): Promise<SupportTicket> {
    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new NotFoundException('Ticket support non trouvé');
    }

    return ticket;
  }

  private async findTicketWithDetails(
    ticketId: string,
  ): Promise<SupportTicket> {
    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId },
      relations: ['user', 'assignedAdmin', 'messages', 'messages.sender'],
      order: {
        messages: {
          createdAt: 'ASC',
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException('Ticket support non trouvé');
    }

    return ticket;
  }

  private async ensureAdminUser(userId: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur admin non trouvé');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Action réservée aux administrateurs');
    }
  }

  private sanitizeTicketSummary(
    ticket: SupportTicket,
  ): SanitizedSupportTicketSummary {
    return {
      id: ticket.id,
      userId: ticket.userId,
      assignedAdminId: ticket.assignedAdminId,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      lastMessageAt: ticket.lastMessageAt,
      firstResponseAt: ticket.firstResponseAt,
      resolvedAt: ticket.resolvedAt,
      closedAt: ticket.closedAt,
      resolutionSummary: ticket.resolutionSummary,
      user: this.sanitizeSupportUser(ticket.user),
      assignedAdmin: this.sanitizeSupportUser(ticket.assignedAdmin),
    };
  }

  private sanitizeTicketDetails(
    ticket: SupportTicket,
    isAdminView: boolean,
  ): SanitizedSupportTicketDetails {
    const messages = (ticket.messages || [])
      .filter((message) => isAdminView || !message.isInternal)
      .map((message) => this.sanitizeSupportMessage(message));

    return {
      ...this.sanitizeTicketSummary(ticket),
      messages,
    };
  }

  private sanitizeSupportMessage(
    message: SupportTicketMessage,
  ): SanitizedSupportMessage {
    return {
      id: message.id,
      ticketId: message.ticketId,
      senderId: message.senderId,
      content: message.content,
      isInternal: message.isInternal,
      createdAt: message.createdAt,
      sender: this.sanitizeSupportUser(message.sender),
    };
  }

  private sanitizeSupportUser(user?: User | null): SanitizedSupportUser | null {
    if (!user) {
      return null;
    }

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    };
  }
}
