import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CreateFieldAgentDto, CreateFieldLeadDto, CreateFieldOrganizationDto, CreateFieldTicketDto, CreatePartnerOrganizationDto, SetFieldTargetDto } from './partners.dto';
import { PartnersService } from './partners.service';

@ApiTags('Partners')
@Auth()
@Controller('partners')
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  @Get('me/organizations')
  listOrganizations(@Request() req) { return this.partners.listOrganizations(req.user.userId); }

  @Post('organizations')
  @SensitiveThrottle(5, 60000)
  createOrganization(@Request() req, @Body() dto: CreatePartnerOrganizationDto) { return this.partners.createOrganization(req.user.userId, dto); }

  @Get('organizations/:id/capabilities')
  capabilities(@Request() req, @Param('id', ParseUUIDPipe) id: string) { return this.partners.capabilities(req.user.userId, id); }

  @Get('organizations/:id/field/overview')
  overview(@Request() req, @Param('id', ParseUUIDPipe) id: string) { return this.partners.overview(req.user.userId, id); }

  @Post('organizations/:id/field/leads')
  @SensitiveThrottle(20, 60000)
  createLead(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFieldLeadDto) { return this.partners.createLead(req.user.userId, id, dto); }

  @Get('organizations/:id/field/tickets')
  tickets(@Request() req, @Param('id', ParseUUIDPipe) id: string) { return this.partners.listTickets(req.user.userId, id); }

  @Post('organizations/:id/field/tickets')
  @SensitiveThrottle(10, 60000)
  createTicket(@Request() req, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFieldTicketDto) { return this.partners.createTicket(req.user.userId, id, dto); }

  @Get('organizations/:id/field/members')
  listFieldMembers(@Request() req, @Param('id', ParseUUIDPipe) id: string) { return this.partners.listFieldMembers(req.user.userId, id); }

  @Post('admin/organizations/:id/activate')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  activate(@Param('id', ParseUUIDPipe) id: string) { return this.partners.activateOrganization(id); }

  @Get('admin/organizations')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  listAdminOrganizations() { return this.partners.listAdminOrganizations(); }

  @Get('admin/organizations/:id/members')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  listAdminMembers(@Param('id', ParseUUIDPipe) id: string, @Query('period') period?: string) { return this.partners.listAdminMembers(id, period); }

  @Post('admin/field/organizations')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @SensitiveThrottle(5, 60000)
  createFieldOrganization(@Body() dto: CreateFieldOrganizationDto) { return this.partners.createFieldOrganization(dto); }

  @Post('admin/organizations/:id/field/agents')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @SensitiveThrottle(10, 60000)
  createFieldAgent(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFieldAgentDto) { return this.partners.createFieldAgent(id, dto); }

  @Delete('admin/organizations/:id/field/agents/:userId')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @SensitiveThrottle(10, 60000)
  removeFieldAgent(@Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) { return this.partners.removeFieldAgent(id, userId); }

  @Put('admin/organizations/:id/field/targets/:agentId')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  setTarget(@Param('id', ParseUUIDPipe) id: string, @Param('agentId', ParseUUIDPipe) agentId: string, @Body() dto: SetFieldTargetDto) { return this.partners.setTarget(id, agentId, dto); }
}
