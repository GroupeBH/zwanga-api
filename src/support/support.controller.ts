import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  CreateSupportConversationDto,
  ListConversationsQueryDto,
  SendMessageDto,
} from '../chat/dto/conversation.dto';
import {
  CreateFaqEntryDto,
  ListFaqQueryDto,
  UpdateFaqEntryDto,
} from '../faq/dto/faq.dto';
import {
  AddSupportTicketMessageDto,
  AssignSupportTicketDto,
  CreateSupportTicketDto,
  ListAdminSupportTicketsQueryDto,
  ListSupportTicketsQueryDto,
  UpdateSupportTicketStatusDto,
} from './dto/support-ticket.dto';
import { SupportService } from './support.service';

@ApiTags('Support')
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  /* -------------------------------------------------------------------------- */
  /*                                     FAQ                                   */
  /* -------------------------------------------------------------------------- */

  @Get('faq')
  @Public()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Lister les FAQ depuis le support center' })
  async listFaq(@Query() query: ListFaqQueryDto) {
    return this.supportService.listFaq(query);
  }

  @Get('faq/:id')
  @Public()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Recuperer une FAQ depuis le support center' })
  async getFaq(@Param('id') id: string) {
    return this.supportService.getFaq(id);
  }

  @Post('faq')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Creer une entree FAQ (Admin)' })
  async createFaq(@Body() dto: CreateFaqEntryDto) {
    return this.supportService.createFaq(dto);
  }

  @Put('faq/:id')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Mettre a jour une entree FAQ (Admin)' })
  async updateFaq(@Param('id') id: string, @Body() dto: UpdateFaqEntryDto) {
    return this.supportService.updateFaq(id, dto);
  }

  @Delete('faq/:id')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Supprimer une entree FAQ (Admin)' })
  async removeFaq(@Param('id') id: string) {
    return this.supportService.removeFaq(id);
  }

  /* -------------------------------------------------------------------------- */
  /*                          Support conversations (legacy)                    */
  /* -------------------------------------------------------------------------- */

  @Post('conversations')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Creer une conversation avec le support' })
  async createConversation(
    @Request() req,
    @Body() dto: CreateSupportConversationDto,
  ) {
    return this.supportService.createSupportConversation(req.user.userId, dto);
  }

  @Get('conversations')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Lister les conversations de support' })
  async listConversations(
    @Request() req,
    @Query() query: ListConversationsQueryDto,
  ) {
    return this.supportService.listSupportConversations(req.user.userId, query);
  }

  @Get('conversations/:id')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Obtenir une conversation de support' })
  async getConversation(@Request() req, @Param('id') id: string) {
    return this.supportService.getSupportConversation(req.user.userId, id);
  }

  @Get('conversations/:id/messages')
  @Auth()
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Lister les messages d une conversation de support' })
  async getMessages(@Request() req, @Param('id') id: string) {
    return this.supportService.getSupportConversationMessages(
      id,
      req.user.userId,
    );
  }

  @Post('conversations/:id/messages')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Envoyer un message au support' })
  async sendMessage(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.supportService.sendSupportMessage(id, req.user.userId, dto);
  }

  /* -------------------------------------------------------------------------- */
  /*                                 User tickets                               */
  /* -------------------------------------------------------------------------- */

  @Post('tickets')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Creer un ticket de support' })
  async createTicket(@Request() req, @Body() dto: CreateSupportTicketDto) {
    return this.supportService.createTicket(req.user.userId, dto);
  }

  @Get('tickets')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Lister mes tickets de support' })
  async listMyTickets(
    @Request() req,
    @Query() query: ListSupportTicketsQueryDto,
  ) {
    return this.supportService.listUserTickets(req.user.userId, query);
  }

  @Get('tickets/:id')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Recuperer un ticket de support' })
  async getMyTicket(@Request() req, @Param('id') id: string) {
    return this.supportService.getUserTicket(req.user.userId, id);
  }

  @Post('tickets/:id/messages')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Ajouter un message a mon ticket' })
  async addMyTicketMessage(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: AddSupportTicketMessageDto,
  ) {
    return this.supportService.addUserTicketMessage(req.user.userId, id, dto);
  }

  @Patch('tickets/:id/close')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Fermer mon ticket de support' })
  async closeMyTicket(@Request() req, @Param('id') id: string) {
    return this.supportService.closeUserTicket(req.user.userId, id);
  }

  @Patch('tickets/:id/reopen')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Rouvrir mon ticket de support' })
  async reopenMyTicket(@Request() req, @Param('id') id: string) {
    return this.supportService.reopenUserTicket(req.user.userId, id);
  }

  /* -------------------------------------------------------------------------- */
  /*                                Admin tickets                               */
  /* -------------------------------------------------------------------------- */

  @Get('admin/tickets')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Lister tous les tickets (Admin)' })
  async listAdminTickets(@Query() query: ListAdminSupportTicketsQueryDto) {
    return this.supportService.listAdminTickets(query);
  }

  @Get('admin/tickets/:id')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Recuperer un ticket (Admin)' })
  async getAdminTicket(@Param('id') id: string) {
    return this.supportService.getAdminTicket(id);
  }

  @Post('admin/tickets/:id/messages')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(60, 60000)
  @ApiOperation({ summary: 'Ajouter un message ticket (Admin)' })
  async addAdminTicketMessage(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: AddSupportTicketMessageDto,
  ) {
    return this.supportService.addAdminTicketMessage(req.user.userId, id, dto);
  }

  @Patch('admin/tickets/:id/assign')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Assigner un ticket a un admin' })
  async assignTicket(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: AssignSupportTicketDto,
  ) {
    return this.supportService.assignTicket(id, req.user.userId, dto);
  }

  @Patch('admin/tickets/:id/status')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Mettre a jour le statut d un ticket (Admin)' })
  async updateTicketStatus(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateSupportTicketStatusDto,
  ) {
    return this.supportService.updateTicketStatus(id, req.user.userId, dto);
  }
}

