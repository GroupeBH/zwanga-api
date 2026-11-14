import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ROLES_KEY } from '../common/guards/roles.guard';
import { User, UserRole } from '../users/entities/user.entity';
import { Notification, NotificationStatus } from '../notifications/entities/notification.entity';
import { PartnerMember, PartnerOrganization } from './partner.entities';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';

const organization = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'ACTIVE',
  partnerTypes: [{ type: 'FIELD_MARKETING', status: 'ACTIVE' }],
};

function fixture(role: string) {
  const member = { userId: '22222222-2222-4222-8222-222222222222', organizationId: organization.id, status: 'ACTIVE', role, organization };
  const members = { findOne: jest.fn().mockResolvedValue(member) };
  const leads = { findOneBy: jest.fn().mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', agentId: 'someone-else' }), find: jest.fn().mockResolvedValue([]) };
  const support = { createTicket: jest.fn() };
  const service = new PartnersService({} as any, members as any, leads as any, { findOneBy: jest.fn().mockResolvedValue(null) } as any, {} as any, {} as any, {} as any, support as any);
  return { service, members, leads, support, member };
}

describe('PartnersService field access', () => {
  it.each(['ACTIVE','SUSPENDED'])('allows receipt reconciliation only to fleet managers in %s fleets', async status => {
    for(const role of ['ORG_ADMIN','ORG_MANAGER','FLEET_MANAGER','VIEWER','FINANCE_VIEWER','FIELD_AGENT']) {
      const {service,members} = fixture(role);
      members.findOne.mockResolvedValue({role,organization:{...organization,status,partnerTypes:[{type:'FLEET_OWNER',status:'ACTIVE'}]}});
      const caps = await service.capabilities('22222222-2222-4222-8222-222222222222',organization.id);
      expect(caps.permissions.includes('fleet.payments.confirm')).toBe(['ORG_ADMIN','ORG_MANAGER','FLEET_MANAGER'].includes(role));
      if(status==='SUSPENDED') expect(caps.permissions).not.toContain('vehicles.assign_driver');
    }
  });
  it('reserves team and agent administration to Zwanga admins', () => {
    for (const method of ['activate', 'listAdminOrganizations', 'listAdminMembers', 'adminFieldReports', 'adminFieldTeam', 'createFieldOrganization', 'createFieldAgent', 'removeFieldAgent', 'setTarget', 'setZones'] as const) {
      expect(Reflect.getMetadata(ROLES_KEY, PartnersController.prototype[method])).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
    }
  });

  it('provisions a field agent as a regular user with scoped team membership', async () => {
    const userRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ ...value, id: '44444444-4444-4444-8444-444444444444' })),
    };
    const memberRepo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const organizations = {
      findOneBy: jest.fn().mockResolvedValue(organization),
      manager: { transaction: jest.fn(async (fn) => fn({ getRepository: (entity) => entity === User ? userRepo : memberRepo })) },
    };
    const service = new PartnersService(organizations as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const result = await service.createFieldAgent(organization.id, { phone: '0812345678', firstName: 'Alice', lastName: 'Ilunga', initialPin: '1234', role: 'FIELD_AGENT' });
    expect(userRepo.save).toHaveBeenCalledWith(expect.objectContaining({ phone: '+243812345678', role: UserRole.PASSENGER }));
    expect(memberRepo.save).toHaveBeenCalledWith(expect.objectContaining({ organizationId: organization.id, userId: result.userId, role: 'FIELD_AGENT', status: 'ACTIVE' }));
  });

  it('returns saved monthly targets to the admin team view', async () => {
    const members = { find: jest.fn().mockResolvedValue([{ userId: '22222222-2222-4222-8222-222222222222', role: 'FIELD_AGENT', user: { firstName: 'Alice', lastName: 'Ilunga', phone: '+243812345678' } }]) };
    const targets = { findBy: jest.fn().mockResolvedValue([{ agentId: '22222222-2222-4222-8222-222222222222', goal: 12 }]) };
    const service = new PartnersService({ exists: jest.fn().mockResolvedValue(true) } as any, members as any, {} as any, targets as any, {} as any, {} as any, {} as any, {} as any);
    const result = await service.listAdminMembers(organization.id, '2026-11');
    expect(result.items).toEqual([expect.objectContaining({ name: 'Alice Ilunga', target: 12 })]);
    expect(targets.findBy).toHaveBeenCalledWith(expect.objectContaining({ organizationId: organization.id, period: '2026-11' }));
  });

  it('limits an agent to their own dossiers and denies team access', async () => {
    const { service } = fixture('FIELD_AGENT');
    const caps = await service.capabilities('22222222-2222-4222-8222-222222222222', organization.id);
    expect(caps.permissions).toContain('recruits.read_own');
    expect(caps.permissions).not.toContain('recruits.read_team');
    expect(caps.permissions).not.toContain('organization.members.invite');
  });

  it('checks lead ownership before creating a linked support ticket', async () => {
    const { service, support } = fixture('FIELD_AGENT');
    await expect(service.createTicket('22222222-2222-4222-8222-222222222222', organization.id, {
      subject: 'Problème conducteur', message: 'Le conducteur ne peut pas valider son identité.', category: 'DRIVER', leadId: '33333333-3333-4333-8333-333333333333',
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(support.createTicket).not.toHaveBeenCalled();
  });

  it('keeps suspended history readable but blocks new tickets', async () => {
    const { service, members } = fixture('FIELD_AGENT');
    members.findOne.mockResolvedValue({ role: 'FIELD_AGENT', organization: { ...organization, status: 'SUSPENDED' } });
    await expect(service.overview('22222222-2222-4222-8222-222222222222', organization.id)).resolves.toMatchObject({ leads: [] });
    await expect(service.createTicket('22222222-2222-4222-8222-222222222222', organization.id, {
      subject: 'Problème conducteur', message: 'Le dossier ne progresse pas.', category: 'DRIVER',
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps an agent report private and writes it under the authenticated agent ID', async () => {
    const { service } = fixture('FIELD_AGENT');
    const report = { id: 'report-1', organizationId: organization.id, agentId: '22222222-2222-4222-8222-222222222222', reportDate: '2026-11-08', contactsCount: 4, summary: 'Quatre contacts à Gombe', zone: 'Gombe', obstacles: null, updatedAt: new Date() };
    const reports = { find: jest.fn().mockResolvedValue([report]), upsert: jest.fn(), findOneByOrFail: jest.fn().mockResolvedValue(report) };
    Object.assign(service, { reports });
    const userId = report.agentId;

    await expect(service.listFieldReports(userId, organization.id)).resolves.toEqual({ items: [expect.objectContaining({ agentId: userId })] });
    expect(reports.find).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: organization.id, agentId: userId } }));
    const reportDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await service.saveFieldReport(userId, organization.id, { reportDate, contactsCount: 4, summary: 'Quatre contacts à Gombe', zone: 'Gombe' });
    expect(reports.upsert).toHaveBeenCalledWith(expect.objectContaining({ organizationId: organization.id, agentId: userId, reportDate }), ['organizationId', 'agentId', 'reportDate']);
  });

  it('stores assigned zones only for a field team member', async () => {
    const member = { userId: 'agent-1', organizationId: organization.id, role: 'FIELD_AGENT', status: 'ACTIVE', zones: [], organization };
    const members = { findOne: jest.fn().mockResolvedValue(member), save: jest.fn(async (value) => value) };
    const service = new PartnersService({} as any, members as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(service.setFieldZones(organization.id, member.userId, { zones: [' Gombe ', 'Lingwala'] })).resolves.toEqual({ agentId: member.userId, zones: ['Gombe', 'Lingwala'] });
    expect(members.save).toHaveBeenCalledWith(expect.objectContaining({ zones: ['Gombe', 'Lingwala'] }));
    await expect(service.setFieldZones(organization.id, member.userId, { zones: ['Gombe', 'gombe'] })).rejects.toThrow();
  });

  it('lets an agent see aggregate team performance and member names without exposing colleagues’ dossiers', async () => {
    const { service, members, leads } = fixture('FIELD_AGENT');
    const teamMembers = [
      { userId: 'agent-1', role: 'FIELD_AGENT', user: { firstName: 'Alice', lastName: 'Ilunga', phone: '+243800000001' } },
      { userId: 'agent-2', role: 'FIELD_AGENT', user: { firstName: 'Jean', lastName: 'Mbuyi', phone: '+243800000002' } },
    ];
    Object.assign(members, { find: jest.fn().mockResolvedValue(teamMembers) });
    leads.find.mockResolvedValue([{ id: 'lead-1' }, { id: 'lead-2' }]);
    Object.assign(service, { targets: { findBy: jest.fn().mockResolvedValue([{ goal: 10 }, { goal: 12 }]) } });
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    jest.spyOn(service as any, 'leadProgress').mockResolvedValue([
      { status: 'FIRST_TRIP', firstTripAt: today, createdAt: yesterday },
      { status: 'REGISTERED', firstTripAt: null, createdAt: yesterday },
    ]);

    const result = await service.fieldTeam('22222222-2222-4222-8222-222222222222', organization.id);
    expect(result.performance).toMatchObject({ agents: 2, contacted: 2, registered: 2, firstTrips: 1, targetGoal: 22, targetsDefined: 2 });
    expect(result.members).toEqual([
      { userId: 'agent-1', name: 'Alice Ilunga', role: 'FIELD_AGENT', zones: [] },
      { userId: 'agent-2', name: 'Jean Mbuyi', role: 'FIELD_AGENT', zones: [] },
    ]);
    expect(JSON.stringify(result)).not.toContain('+243800000002');
    expect(JSON.stringify(result)).not.toContain('lead-2');
  });

  it('denies team performance when the user has no active team membership', async () => {
    const { service, members } = fixture('FIELD_AGENT');
    members.findOne.mockResolvedValue(null);
    await expect(service.fieldTeam('22222222-2222-4222-8222-222222222222', organization.id)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PartnersService partner approvals', () => {
  it('records an approval request and one in-app notification per active admin in the same transaction', async () => {
    const adminRepo = { find: jest.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]) };
    const notificationRepo = { create: jest.fn((value) => value), save: jest.fn(async (value) => value) };
    const manager = {
      create: jest.fn((_entity, value) => value),
      save: jest.fn(async (value) => 'partnerTypes' in value ? { ...value, id: organization.id } : value),
      getRepository: jest.fn((entity) => entity === User ? adminRepo : entity === Notification ? notificationRepo : null),
    };
    const organizations = { manager: { transaction: jest.fn(async (fn) => fn(manager)) } };
    const service = new PartnersService(organizations as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    const result = await service.createOrganization('creator-1', {
      displayName: 'Société Exemple', legalType: 'COMPANY', partnerTypes: ['FLEET_OWNER'],
    });

    expect(result).toMatchObject({ id: organization.id, status: 'PROSPECT', roles: ['ORG_ADMIN'] });
    expect(manager.create).toHaveBeenCalledWith(PartnerOrganization, expect.objectContaining({ status: 'PROSPECT', partnerTypes: [{ type: 'FLEET_OWNER', status: 'REQUESTED' }] }));
    expect(manager.create).toHaveBeenCalledWith(PartnerMember, expect.objectContaining({ userId: 'creator-1', role: 'ORG_ADMIN' }));
    expect(notificationRepo.save).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'admin-1', status: NotificationStatus.SENT, data: { type: 'partner_space_created', organizationId: organization.id } }),
      expect.objectContaining({ userId: 'admin-2', status: NotificationStatus.SENT, data: { type: 'partner_space_created', organizationId: organization.id } }),
    ]);
    expect(organizations.manager.transaction).toHaveBeenCalledTimes(1);
  });

  it('approves a pending partner request once and rejects repeated or field-team approval', async () => {
    const pending = { id: organization.id, status: 'PROSPECT', partnerTypes: [{ type: 'AFFILIATE', status: 'REQUESTED' }] };
    const repo = { findOne: jest.fn().mockResolvedValue(pending) };
    const manager = { getRepository: jest.fn().mockReturnValue(repo), save: jest.fn(async (value) => value) };
    const organizations = { manager: { transaction: jest.fn(async (fn) => fn(manager)) } };
    const service = new PartnersService(organizations as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await expect(service.activateOrganization(organization.id)).resolves.toMatchObject({ status: 'ACTIVE', partnerTypes: [{ type: 'AFFILIATE', status: 'ACTIVE' }] });
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: organization.id }, lock: { mode: 'pessimistic_write' } });
    await expect(service.activateOrganization(organization.id)).rejects.toBeInstanceOf(ConflictException);
    repo.findOne.mockResolvedValue({ id: organization.id, status: 'PROSPECT', partnerTypes: [{ type: 'FIELD_MARKETING', status: 'REQUESTED' }] });
    await expect(service.activateOrganization(organization.id)).rejects.toBeInstanceOf(ConflictException);
    expect(manager.save).toHaveBeenCalledTimes(1);
  });
});
