import { ForbiddenException } from '@nestjs/common';
import { ROLES_KEY } from '../common/guards/roles.guard';
import { User, UserRole } from '../users/entities/user.entity';
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
  it('reserves team and agent administration to Zwanga admins', () => {
    for (const method of ['createFieldOrganization', 'createFieldAgent', 'removeFieldAgent', 'setTarget'] as const) {
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
});
