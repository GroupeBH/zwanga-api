import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { buildProfileState } from '../users/profile-state';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { SupportService } from '../support/support.service';
import { SupportTicketCategory, SupportTicketPriority } from '../support/entities/support-ticket.entity';
import { CreateFieldAgentDto, CreateFieldLeadDto, CreateFieldOrganizationDto, CreateFieldTicketDto, CreatePartnerOrganizationDto, SetFieldTargetDto } from './partners.dto';
import { PartnerFieldLead, PartnerFieldTarget, PartnerFieldTicket, PartnerMember, PartnerOrganization } from './partner.entities';
import { canonicalFieldPhone, fieldPhoneVariants } from './field-phone';

const FIELD_PERMISSIONS = ['organization.read', 'support.tickets', 'support.tickets.read', 'leads.create', 'recruits.read_own', 'targets.read_own', 'issues.create'];
const SUPERVISOR_PERMISSIONS = [...FIELD_PERMISSIONS, 'recruits.read_team', 'organization.members.read'];
const ADMIN_PERMISSIONS = SUPERVISOR_PERMISSIONS;

@Injectable()
export class PartnersService {
  constructor(
    @InjectRepository(PartnerOrganization) private readonly organizations: Repository<PartnerOrganization>,
    @InjectRepository(PartnerMember) private readonly members: Repository<PartnerMember>,
    @InjectRepository(PartnerFieldLead) private readonly leads: Repository<PartnerFieldLead>,
    @InjectRepository(PartnerFieldTarget) private readonly targets: Repository<PartnerFieldTarget>,
    @InjectRepository(PartnerFieldTicket) private readonly tickets: Repository<PartnerFieldTicket>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    private readonly support: SupportService,
  ) {}

  private async member(userId: string, organizationId: string): Promise<PartnerMember> {
    const member = await this.members.findOne({ where: { userId, organizationId, status: 'ACTIVE' }, relations: { organization: true } });
    if (!member) throw new ForbiddenException('Accès refusé');
    return member;
  }

  private async fieldMember(userId: string, organizationId: string, write = false): Promise<PartnerMember> {
    const member = await this.member(userId, organizationId);
    if ((write ? member.organization.status !== 'ACTIVE' : !['ACTIVE', 'SUSPENDED', 'CLOSED'].includes(member.organization.status)) || !member.organization.partnerTypes.some((type) => type.type === 'FIELD_MARKETING' && type.status === 'ACTIVE') || !['ORG_ADMIN', 'FIELD_SUPERVISOR', 'FIELD_AGENT'].includes(member.role)) {
      throw new ForbiddenException('Accès terrain refusé');
    }
    return member;
  }

  private toMine(member: PartnerMember) {
    const organization = member.organization;
    return { id: organization.id, displayName: organization.displayName, legalType: organization.legalType, status: organization.status, membershipStatus: member.status, roles: [member.role], partnerTypes: organization.partnerTypes };
  }

  async listOrganizations(userId: string) {
    const members = await this.members.find({ where: { userId, status: 'ACTIVE' }, relations: { organization: true }, order: { createdAt: 'DESC' } });
    return { items: members.map((member) => this.toMine(member)) };
  }

  async createOrganization(userId: string, dto: CreatePartnerOrganizationDto) {
    if (new Set(dto.partnerTypes).size !== dto.partnerTypes.length) throw new BadRequestException('Catégories en double');
    if (dto.partnerTypes.includes('FIELD_MARKETING')) throw new ForbiddenException('Les espaces terrain sont créés par Zwanga');
    return this.organizations.manager.transaction(async (manager) => {
      const organization = await manager.save(manager.create(PartnerOrganization, {
        displayName: dto.displayName.trim(), legalName: dto.legalName?.trim() ?? null, legalType: dto.legalType,
        status: 'PROSPECT', partnerTypes: dto.partnerTypes.map((type) => ({ type, status: 'REQUESTED' })),
      }));
      const member = await manager.save(manager.create(PartnerMember, { organizationId: organization.id, userId, role: 'ORG_ADMIN', status: 'ACTIVE' }));
      member.organization = organization;
      return this.toMine(member);
    });
  }

  async capabilities(userId: string, organizationId: string) {
    const member = await this.member(userId, organizationId);
    const organization = member.organization;
    const activePartnerTypes = organization.partnerTypes.filter((type) => type.status === 'ACTIVE').map((type) => type.type);
    const fieldAvailable = activePartnerTypes.includes('FIELD_MARKETING');
    const rolePermissions = member.role === 'ORG_ADMIN' ? ADMIN_PERMISSIONS : member.role === 'FIELD_SUPERVISOR' ? SUPERVISOR_PERMISSIONS : member.role === 'FIELD_AGENT' ? FIELD_PERMISSIONS : ['organization.read'];
    const permissions = !fieldAvailable ? ['organization.read'] : organization.status === 'ACTIVE' ? rolePermissions : ['SUSPENDED', 'CLOSED'].includes(organization.status) ? rolePermissions.filter((permission) => ['organization.read', 'support.tickets.read', 'recruits.read_own', 'recruits.read_team', 'targets.read_own', 'organization.members.read'].includes(permission)) : ['organization.read'];
    return {
      organizationId, organizationStatus: organization.status, roles: [member.role], activePartnerTypes,
      features: fieldAvailable ? ['marketing.campaigns'] : [], permissions,
    };
  }

  async activateOrganization(organizationId: string) {
    const organization = await this.organizations.findOneBy({ id: organizationId });
    if (!organization) throw new NotFoundException('Espace inconnu');
    organization.status = 'ACTIVE';
    organization.partnerTypes = organization.partnerTypes.map((type) => ({ ...type, status: 'ACTIVE' }));
    await this.organizations.save(organization);
    return { id: organization.id, status: organization.status, partnerTypes: organization.partnerTypes };
  }

  async listAdminOrganizations() {
    const organizations = await this.organizations.find({ order: { createdAt: 'DESC' }, take: 200 });
    return { items: organizations.map((organization) => ({ id: organization.id, displayName: organization.displayName, legalType: organization.legalType, status: organization.status, partnerTypes: organization.partnerTypes, createdAt: organization.createdAt })) };
  }

  async listAdminMembers(organizationId: string, requestedPeriod?: string) {
    if (!await this.organizations.exists({ where: { id: organizationId } })) throw new NotFoundException('Espace inconnu');
    if (requestedPeriod && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedPeriod)) throw new BadRequestException('Mois invalide');
    const period = requestedPeriod ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kinshasa', year: 'numeric', month: '2-digit' }).format(new Date());
    const members = await this.members.find({ where: { organizationId, status: 'ACTIVE' }, relations: { user: true }, order: { createdAt: 'ASC' } });
    const targets = members.length ? await this.targets.findBy({ organizationId, period, agentId: In(members.map((member) => member.userId)) }) : [];
    const targetByAgent = new Map(targets.map((target) => [target.agentId, target.goal]));
    return { items: members.map((member) => ({ userId: member.userId, name: [member.user?.firstName, member.user?.lastName].filter(Boolean).join(' '), phone: member.user?.phone ?? null, role: member.role, target: targetByAgent.get(member.userId) ?? null })) };
  }

  async createFieldOrganization(dto: CreateFieldOrganizationDto) {
    if (dto.displayName.trim().length < 2) throw new BadRequestException('Nom d’équipe trop court');
    const organization = await this.organizations.save(this.organizations.create({
      displayName: dto.displayName.trim(), legalName: null, legalType: 'COMPANY', status: 'ACTIVE',
      partnerTypes: [{ type: 'FIELD_MARKETING', status: 'ACTIVE' }],
    }));
    return { id: organization.id, displayName: organization.displayName, status: organization.status };
  }

  async createFieldAgent(organizationId: string, dto: CreateFieldAgentDto) {
    const existing = dto.accountMode === 'existing' || dto.userId !== undefined;
    if (existing) {
      if (!dto.userId || dto.accountMode === 'new' || [dto.phone, dto.firstName, dto.lastName, dto.initialPin].some(value => value !== undefined)) {
        throw new BadRequestException('Sélectionnez un utilisateur existant sans renseigner de nouveau compte');
      }
    } else if (!dto.firstName || !dto.lastName || dto.firstName.trim().length < 2 || dto.lastName.trim().length < 2) {
      throw new BadRequestException('Nom d’agent invalide');
    }
    if (!existing && !dto.phone) throw new BadRequestException('Le téléphone est requis pour un nouveau compte');
    if (dto.accountMode === 'new' && !dto.initialPin) throw new BadRequestException('Le code PIN initial est requis pour un nouveau compte');
    const organization = await this.organizations.findOneBy({ id: organizationId });
    if (!organization || organization.status !== 'ACTIVE' || !organization.partnerTypes.some((type) => type.type === 'FIELD_MARKETING' && type.status === 'ACTIVE')) throw new NotFoundException('Équipe terrain inconnue');
    const canonical = existing ? null : canonicalFieldPhone(dto.phone!);
    // Hash before acquiring database locks; an existing account never changes PIN.
    const password = !existing && dto.initialPin ? await bcrypt.hash(dto.initialPin, 10) : undefined;
    try {
      return await this.organizations.manager.transaction(async (manager) => {
        const userRepo = manager.getRepository(User);
        const memberRepo = manager.getRepository(PartnerMember);
        let user = await userRepo.findOne({
          where: existing ? { id: dto.userId } : { phone: In(fieldPhoneVariants(canonical!)) },
          select: ['id', 'phone', 'firstName', 'lastName', 'role', 'status', 'isActive', 'password'],
          lock: { mode: 'pessimistic_write' },
        });
        if (existing && !user) throw new NotFoundException('Utilisateur sélectionné introuvable');
        if (dto.accountMode === 'new' && user) throw new ConflictException('Ce numéro appartient déjà à un compte. Choisissez « Utilisateur existant ».');
        if (!user) {
          if (!dto.initialPin) throw new BadRequestException('Le code PIN initial est requis pour un nouveau compte');
          user = await userRepo.save(userRepo.create({
            phone: canonical!, firstName: dto.firstName!.trim(), lastName: dto.lastName!.trim(),
            password, role: UserRole.PASSENGER,
            status: UserStatus.ACTIVE, isActive: true, isDriver: false, isPhoneVerified: false,
          }));
        } else if (!user.isActive || [UserStatus.SUSPENDED, UserStatus.INACTIVE].includes(user.status) || [UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.MARKETER].includes(user.role)) {
          throw new ForbiddenException('Ce compte ne peut pas être agent terrain');
        } else if (!user.password) {
          throw new BadRequestException('Ce compte doit définir un PIN avant son affectation');
        } else if (!user.phone) {
          throw new BadRequestException('Ce compte doit renseigner un téléphone avant son affectation');
        }
        let member = await memberRepo.findOneBy({ organizationId, userId: user.id });
        if (member?.status === 'ACTIVE') throw new ConflictException('Agent déjà présent dans cette équipe');
        member ??= memberRepo.create({ organizationId, userId: user.id });
        member.role = dto.role ?? 'FIELD_AGENT';
        member.status = 'ACTIVE';
        await memberRepo.save(member);
        return { userId: user.id, name: [user.firstName, user.lastName].join(' '), phone: user.phone, role: member.role, status: member.status };
      });
    } catch (error) {
      // A concurrent creation is a conflict, never a partially created membership.
      if (error?.code === '23505' || error?.driverError?.code === '23505') {
        throw new ConflictException('Ce compte ou cette affectation existe déjà. Actualisez la liste des utilisateurs.');
      }
      throw error;
    }
  }

  async listFieldMembers(userId: string, organizationId: string) {
    const actor = await this.fieldMember(userId, organizationId);
    if (!['ORG_ADMIN', 'FIELD_SUPERVISOR'].includes(actor.role)) throw new ForbiddenException('Accès membres refusé');
    const members = await this.members.find({ where: { organizationId, status: 'ACTIVE' }, relations: { user: true }, order: { createdAt: 'ASC' } });
    return { items: members.map((member) => ({ userId: member.userId, name: [member.user?.firstName, member.user?.lastName].filter(Boolean).join(' '), phone: member.user?.phone ?? null, role: member.role, status: member.status })) };
  }

  async removeFieldAgent(organizationId: string, targetUserId: string) {
    const target = await this.members.findOneBy({ organizationId, userId: targetUserId, status: 'ACTIVE' });
    if (!target || !['FIELD_AGENT', 'FIELD_SUPERVISOR'].includes(target.role)) throw new NotFoundException('Agent terrain inconnu');
    target.status = 'REMOVED';
    await this.members.save(target);
    return { ok: true };
  }

  private async leadProgress(leads: PartnerFieldLead[]) {
    const phones = [...new Set(leads.flatMap((lead) => fieldPhoneVariants(lead.phone)))];
    const users = phones.length ? await this.users.find({ where: { phone: In(phones) }, relations: { kycDocuments: true, vehicles: true } }) : [];
    const byPhone = new Map(users.map((user) => [canonicalFieldPhone(user.phone), user]));
    const ids = users.map((user) => user.id);
    const firstTrips = ids.length ? await this.trips.createQueryBuilder('trip')
      .select('trip.driverId', 'driverId').addSelect('MIN(trip.completedAt)', 'firstTripAt')
      .where('trip.driverId IN (:...ids)', { ids }).andWhere('trip.status = :status', { status: TripStatus.COMPLETED })
      .andWhere('trip.completedAt IS NOT NULL').groupBy('trip.driverId').getRawMany<{ driverId: string; firstTripAt: Date }>() : [];
    const tripByUser = new Map(firstTrips.map((trip) => [trip.driverId, trip.firstTripAt]));
    return leads.map((lead) => {
      const user = byPhone.get(lead.phone);
      const firstTripAt = user ? tripByUser.get(user.id) : undefined;
      let status = 'CONTACTED';
      if (user) {
        const profile = buildProfileState(user);
        status = 'REGISTERED';
        if (profile.driver.requested) {
          status = 'ONBOARDING';
          if (profile.identity.status === 'pending') status = 'KYC_PENDING';
          if (profile.identity.status === 'rejected') status = 'KYC_REJECTED';
          if (profile.identity.status === 'approved') status = 'KYC_APPROVED';
          if (profile.driver.canPublish) status = 'READY_TO_DRIVE';
        }
        if (firstTripAt) status = 'FIRST_TRIP';
      }
      return { id: lead.id, firstName: lead.firstName, lastName: lead.lastName, phone: lead.phone, city: lead.city, agentId: lead.agentId, status, createdAt: lead.createdAt, updatedAt: firstTripAt ?? lead.updatedAt, firstTripAt: firstTripAt ?? null };
    });
  }

  async overview(userId: string, organizationId: string) {
    const member = await this.fieldMember(userId, organizationId);
    const team = member.role !== 'FIELD_AGENT';
    const leads = await this.leads.find({ where: team ? { organizationId } : { organizationId, agentId: userId }, order: { createdAt: 'DESC' } });
    const progress = await this.leadProgress(leads);
    const period = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kinshasa', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const target = await this.targets.findOneBy({ organizationId, agentId: userId, period });
    const achieved = progress.filter((lead) => lead.agentId === userId && lead.firstTripAt && new Date(lead.firstTripAt).getTime() >= new Date(lead.createdAt).getTime() && new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kinshasa', year: 'numeric', month: '2-digit' }).format(new Date(lead.firstTripAt)).startsWith(period)).length;
    return { target: target ? { period, goal: target.goal, achieved } : null, leads: progress.map(({ firstTripAt: _firstTripAt, ...lead }) => lead) };
  }

  async createLead(userId: string, organizationId: string, dto: CreateFieldLeadDto) {
    await this.fieldMember(userId, organizationId, true);
    const phone = canonicalFieldPhone(dto.phone);
    if (await this.leads.exists({ where: { organizationId, phone } })) throw new ConflictException('Conducteur déjà démarché');
    const lead = await this.leads.save(this.leads.create({ organizationId, agentId: userId, firstName: dto.firstName.trim(), lastName: dto.lastName.trim(), phone, city: dto.city.trim() }));
    return (await this.leadProgress([lead]))[0];
  }

  async setTarget(organizationId: string, agentId: string, dto: SetFieldTargetDto) {
    const member = await this.members.findOne({ where: { organizationId, userId: agentId, status: 'ACTIVE' }, relations: { organization: true } });
    if (!member || !['FIELD_AGENT', 'FIELD_SUPERVISOR'].includes(member.role) || member.organization.status !== 'ACTIVE' || !member.organization.partnerTypes.some((type) => type.type === 'FIELD_MARKETING' && type.status === 'ACTIVE')) throw new NotFoundException('Agent terrain inconnu');
    let target = await this.targets.findOneBy({ organizationId, agentId, period: dto.period });
    target ??= this.targets.create({ organizationId, agentId, period: dto.period });
    target.goal = dto.goal;
    return this.targets.save(target);
  }

  private ticketView(ticket: PartnerFieldTicket) {
    return { id: ticket.id, subject: ticket.supportTicket.subject.replace(/^\[Terrain\] /, ''), message: ticket.message, category: ticket.category, status: ticket.supportTicket.status.toUpperCase(), createdAt: ticket.createdAt, authorId: ticket.authorId };
  }

  async listTickets(userId: string, organizationId: string) {
    const member = await this.fieldMember(userId, organizationId);
    const items = await this.tickets.find({ where: member.role === 'FIELD_AGENT' ? { organizationId, authorId: userId } : { organizationId }, relations: { supportTicket: true }, order: { createdAt: 'DESC' } });
    return { items: items.map((ticket) => this.ticketView(ticket)) };
  }

  async createTicket(userId: string, organizationId: string, dto: CreateFieldTicketDto) {
    const member = await this.fieldMember(userId, organizationId, true);
    if (dto.leadId) {
      const lead = await this.leads.findOneBy({ id: dto.leadId, organizationId });
      if (!lead || (member.role === 'FIELD_AGENT' && lead.agentId !== userId)) throw new ForbiddenException('Conducteur inaccessible');
    }
    const subject = `[Terrain] ${dto.subject.trim()}`.slice(0, 120);
    const supportTicket = await this.support.createTicket(userId, { subject, message: dto.message.trim(), category: SupportTicketCategory.OTHER, priority: SupportTicketPriority.MEDIUM });
    const ticket = await this.tickets.save(this.tickets.create({ organizationId, authorId: userId, supportTicketId: supportTicket.id, leadId: dto.leadId ?? null, category: dto.category, message: dto.message.trim() }));
    const saved = await this.tickets.findOneOrFail({ where: { id: ticket.id }, relations: { supportTicket: true } });
    return this.ticketView(saved);
  }
}
