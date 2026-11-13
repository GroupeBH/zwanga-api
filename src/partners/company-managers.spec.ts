import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import * as bcrypt from 'bcrypt';
import { ROLES_KEY } from '../common/guards/roles.guard';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { PartnerMember, PartnerOrganization } from './partner.entities';
import { PartnersController } from './partners.controller';
import { AddCompanyManagerDto, CreateCompanyOrganizationDto } from './partners.dto';
import { PartnersService } from './partners.service';

describe('Company routes', () => {
  it.each([
    ['createCompanyOrganization', RequestMethod.POST, 'admin/organizations'],
    ['addCompanyManager', RequestMethod.POST, 'admin/organizations/:id/managers'],
    ['removeCompanyManager', RequestMethod.DELETE, 'admin/organizations/:id/managers/:userId'],
  ] as const)('%s is %s /partners/%s, reserved to Zwanga admins', (handler, method, path) => {
    const target = PartnersController.prototype[handler];
    expect(Reflect.getMetadata(METHOD_METADATA, target)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, target)).toBe(path);
    expect(Reflect.getMetadata(ROLES_KEY, target)).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
  });
});

const userId = '22222222-2222-4222-8222-222222222222';
const organizationId = '11111111-1111-4111-8111-111111111111';
const company = { id: organizationId, displayName: 'Transco', legalType: 'COMPANY', status: 'ACTIVE', partnerTypes: [{ type: 'FLEET_OWNER', status: 'ACTIVE' }] };
const existingUser = { id: userId, firstName: 'Marie', lastName: 'Lukusa', phone: '+243822233344', password: 'existing-hash', role: UserRole.PASSENGER, status: UserStatus.ACTIVE, isActive: true };
const newAccount: AddCompanyManagerDto = { accountMode: 'new', role: 'ORG_MANAGER', firstName: ' Joseph ', lastName: ' Kabeya ', phone: '0899990000', initialPin: '4821' };

function fixture({ user = { ...existingUser } as any, member = null as any, organization = { ...company } as any, admins = 1 } = {}) {
  const userRepo = { findOne: jest.fn().mockResolvedValue(user), create: jest.fn(value => value), save: jest.fn(async value => ({ id: userId, ...value })) };
  const memberRepo = { findOneBy: jest.fn().mockResolvedValue(member), countBy: jest.fn().mockResolvedValue(admins), create: jest.fn(value => value), save: jest.fn(async value => value) };
  const lockedOrganizations = { findOne: jest.fn().mockResolvedValue(organization) };
  const transaction = jest.fn(async fn => fn({ getRepository: entity => entity === User ? userRepo : entity === PartnerMember ? memberRepo : entity === PartnerOrganization ? lockedOrganizations : undefined }));
  const organizations = {
    findOneBy: jest.fn().mockResolvedValue(organization),
    create: jest.fn(value => value),
    save: jest.fn(async value => ({ id: organizationId, createdAt: new Date('2026-11-12T09:00:00Z'), ...value })),
    manager: { transaction },
  };
  const service = new PartnersService(organizations as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { service, organizations, lockedOrganizations, userRepo, memberRepo, transaction };
}

describe('Company creation by Zwanga', () => {
  it('creates an active company with active categories and no member', async () => {
    const f = fixture();
    const result = await f.service.createCompanyOrganization({ displayName: ' Transco Kinshasa ', legalName: ' Transco SARL ', partnerTypes: ['FLEET_OWNER', 'AFFILIATE'] });
    expect(f.organizations.save).toHaveBeenCalledWith({
      displayName: 'Transco Kinshasa', legalName: 'Transco SARL', legalType: 'COMPANY', status: 'ACTIVE',
      partnerTypes: [{ type: 'FLEET_OWNER', status: 'ACTIVE' }, { type: 'AFFILIATE', status: 'ACTIVE' }],
    });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: organizationId, displayName: 'Transco Kinshasa', legalName: 'Transco SARL', legalType: 'COMPANY', status: 'ACTIVE',
      partnerTypes: [{ type: 'FLEET_OWNER', status: 'ACTIVE' }, { type: 'AFFILIATE', status: 'ACTIVE' }], createdAt: new Date('2026-11-12T09:00:00Z'),
    });
  });

  it('stores a blank legal name as missing', async () => {
    const f = fixture();
    await f.service.createCompanyOrganization({ displayName: 'Transco', legalName: '   ', partnerTypes: ['AFFILIATE'] });
    expect(f.organizations.save).toHaveBeenCalledWith(expect.objectContaining({ legalName: null }));
  });

  it.each([
    { displayName: '   ', partnerTypes: ['AFFILIATE'] },
    { displayName: 'Transco', partnerTypes: ['AFFILIATE', 'AFFILIATE'] },
    { displayName: 'Transco', partnerTypes: ['FIELD_MARKETING'] },
    { displayName: 'Transco', partnerTypes: [] },
  ])('refuses an invalid company before any write: %j', async dto => {
    const f = fixture();
    await expect(f.service.createCompanyOrganization(dto as CreateCompanyOrganizationDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.organizations.save).not.toHaveBeenCalled();
  });
});

describe('Company managers', () => {
  it('links an existing account by ID without changing its profile, PIN or application role', async () => {
    const f = fixture();
    const result = await f.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_MANAGER' });
    expect(f.userRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: userId }, lock: { mode: 'pessimistic_write' } }));
    expect(f.userRepo.save).not.toHaveBeenCalled();
    expect(f.memberRepo.save).toHaveBeenCalledWith(expect.objectContaining({ organizationId, userId, role: 'ORG_MANAGER', status: 'ACTIVE' }));
    expect(result).toEqual({ userId, name: 'Marie Lukusa', phone: '+243822233344', role: 'ORG_MANAGER', status: 'ACTIVE' });
    expect(result).not.toHaveProperty('password');
  });

  it('creates a normal account with a hashed initial PIN and its membership together', async () => {
    const f = fixture({ user: null });
    const result = await f.service.addCompanyManager(organizationId, { ...newAccount, role: 'ORG_ADMIN' });
    const saved = f.userRepo.save.mock.calls[0][0];
    expect(saved).toMatchObject({ firstName: 'Joseph', lastName: 'Kabeya', phone: '+243899990000', role: UserRole.PASSENGER, isPhoneVerified: false });
    expect(await bcrypt.compare('4821', saved.password)).toBe(true);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ userId, name: 'Joseph Kabeya', phone: '+243899990000', role: 'ORG_ADMIN', status: 'ACTIVE' });
  });

  it('does not silently link an existing phone in new account mode', async () => {
    const f = fixture();
    await expect(f.service.addCompanyManager(organizationId, newAccount)).rejects.toBeInstanceOf(ConflictException);
    expect(f.userRepo.save).not.toHaveBeenCalled();
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it('does not create a replacement for an unknown selected user', async () => {
    const f = fixture({ user: null });
    await expect(f.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_ADMIN' })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.userRepo.save).not.toHaveBeenCalled();
  });

  it.each([
    { isActive: false }, { status: UserStatus.INACTIVE }, { status: UserStatus.SUSPENDED },
    { role: UserRole.ADMIN }, { role: UserRole.SUPER_ADMIN }, { role: UserRole.MARKETER },
  ])('refuses an ineligible selected account: %j', async override => {
    const f = fixture({ user: { ...existingUser, ...override } });
    await expect(f.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it.each([{ password: null }, { phone: null }])('requires existing login credentials without setting them: %j', async override => {
    const f = fixture({ user: { ...existingUser, ...override } });
    await expect(f.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_ADMIN' })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.userRepo.save).not.toHaveBeenCalled();
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it.each([
    { accountMode: 'existing', role: 'ORG_ADMIN' },
    { accountMode: 'existing', userId, role: 'ORG_ADMIN', initialPin: '1234' },
    { accountMode: 'existing', userId, role: 'ORG_ADMIN', phone: '+243822233344' },
    { ...newAccount, userId },
    { ...newAccount, initialPin: undefined },
    { ...newAccount, phone: undefined },
    { ...newAccount, firstName: '  ' },
    { accountMode: 'existing', userId, role: 'FIELD_AGENT' },
  ])('rejects an incomplete or ambiguous request before any write: %j', async dto => {
    const f = fixture();
    await expect(f.service.addCompanyManager(organizationId, dto as AddCompanyManagerDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown company', null, NotFoundException],
    ['field team', { ...company, partnerTypes: [{ type: 'FIELD_MARKETING', status: 'ACTIVE' }] }, NotFoundException],
    ['closed company', { ...company, status: 'CLOSED' }, ConflictException],
  ])('does not attach anyone to a %s', async (_label, organization, error) => {
    const f = fixture({ organization });
    await expect(f.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_ADMIN' })).rejects.toBeInstanceOf(error);
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('accepts a company that is still awaiting validation', async () => {
    const f = fixture({ organization: { ...company, status: 'PROSPECT' } });
    await expect(f.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_ADMIN' })).resolves.toMatchObject({ role: 'ORG_ADMIN' });
  });

  it('rejects a duplicate membership and reactivates a removed one with the new role', async () => {
    const active = fixture({ member: { userId, organizationId, role: 'ORG_ADMIN', status: 'ACTIVE' } });
    await expect(active.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_MANAGER' })).rejects.toBeInstanceOf(ConflictException);
    expect(active.memberRepo.save).not.toHaveBeenCalled();
    const removed = fixture({ member: { id: 'membership', userId, organizationId, role: 'ORG_ADMIN', status: 'REMOVED' } });
    await removed.service.addCompanyManager(organizationId, { accountMode: 'existing', userId, role: 'ORG_MANAGER' });
    expect(removed.memberRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'membership', role: 'ORG_MANAGER', status: 'ACTIVE' }));
  });

  it('reports concurrent duplicate creation as a conflict rather than an internal error', async () => {
    const f = fixture({ user: null });
    f.userRepo.save.mockRejectedValue({ code: '23505' });
    await expect(f.service.addCompanyManager(organizationId, newAccount)).rejects.toBeInstanceOf(ConflictException);
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });
});

describe('Company manager removal', () => {
  it('removes a manager under a company lock and keeps the account', async () => {
    const f = fixture({ member: { userId, organizationId, role: 'ORG_MANAGER', status: 'ACTIVE' } });
    await expect(f.service.removeCompanyManager(organizationId, userId)).resolves.toEqual({ ok: true });
    expect(f.lockedOrganizations.findOne).toHaveBeenCalledWith({ where: { id: organizationId }, lock: { mode: 'pessimistic_write' } });
    expect(f.memberRepo.save).toHaveBeenCalledWith(expect.objectContaining({ userId, status: 'REMOVED' }));
    expect(f.userRepo.save).not.toHaveBeenCalled();
  });

  it('never removes the last responsable of a company', async () => {
    const last = fixture({ member: { userId, organizationId, role: 'ORG_ADMIN', status: 'ACTIVE' }, admins: 1 });
    await expect(last.service.removeCompanyManager(organizationId, userId)).rejects.toBeInstanceOf(ConflictException);
    expect(last.memberRepo.countBy).toHaveBeenCalledWith({ organizationId, role: 'ORG_ADMIN', status: 'ACTIVE' });
    expect(last.memberRepo.save).not.toHaveBeenCalled();
    const another = fixture({ member: { userId, organizationId, role: 'ORG_ADMIN', status: 'ACTIVE' }, admins: 2 });
    await expect(another.service.removeCompanyManager(organizationId, userId)).resolves.toEqual({ ok: true });
  });

  it.each([
    ['an unknown member', { member: null }],
    ['a field agent', { member: { userId, organizationId, role: 'FIELD_AGENT', status: 'ACTIVE' } }],
    ['a field team', { member: { userId, organizationId, role: 'ORG_ADMIN', status: 'ACTIVE' }, organization: { ...company, partnerTypes: [{ type: 'FIELD_MARKETING', status: 'ACTIVE' }] } }],
    ['an unknown company', { member: { userId, organizationId, role: 'ORG_MANAGER', status: 'ACTIVE' }, organization: null }],
  ])('refuses to remove %s', async (_label, options) => {
    const f = fixture(options as any);
    await expect(f.service.removeCompanyManager(organizationId, userId)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });
});

describe('Company DTO validation', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const validate = (metatype: any, value: unknown) => pipe.transform(value, { type: 'body', metatype });

  it.each([
    { displayName: 'Transco Kinshasa', legalName: 'Transco SARL', partnerTypes: ['FLEET_OWNER'] },
    { displayName: 'Transco', partnerTypes: ['FLEET_OWNER', 'AFFILIATE'] },
  ])('accepts a company: %j', async value => {
    await expect(validate(CreateCompanyOrganizationDto, value)).resolves.toBeInstanceOf(CreateCompanyOrganizationDto);
  });

  it.each([
    { displayName: 'T', partnerTypes: ['FLEET_OWNER'] },
    { displayName: 'Transco', partnerTypes: [] },
    { displayName: 'Transco', partnerTypes: ['FIELD_MARKETING'] },
    { displayName: 'Transco', partnerTypes: ['FLEET_OWNER', 'AFFILIATE', 'FLEET_OWNER'] },
    { displayName: 'Transco', legalName: '', partnerTypes: ['FLEET_OWNER'] },
    { displayName: 'Transco', partnerTypes: ['FLEET_OWNER'], legalType: 'CHURCH' },
    { displayName: 'Transco', partnerTypes: ['FLEET_OWNER'], status: 'ACTIVE' },
  ])('rejects an invalid company: %j', async value => {
    await expect(validate(CreateCompanyOrganizationDto, value)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    { accountMode: 'existing', userId, role: 'ORG_ADMIN' },
    { accountMode: 'existing', userId, role: 'ORG_MANAGER' },
    newAccount,
  ])('accepts a manager: %j', async value => {
    await expect(validate(AddCompanyManagerDto, value)).resolves.toBeInstanceOf(AddCompanyManagerDto);
  });

  it.each([
    { userId, role: 'ORG_ADMIN' },
    { accountMode: 'existing', userId },
    { accountMode: 'existing', userId, role: 'FIELD_AGENT' },
    { accountMode: 'existing', userId: 'invalid', role: 'ORG_ADMIN' },
    { ...newAccount, initialPin: undefined },
    { ...newAccount, initialPin: 'abcd' },
    { ...newAccount, phone: 'invalid' },
    { accountMode: 'existing', userId, role: 'ORG_ADMIN', organizationId },
    { accountMode: 'existing', userId, role: 'ORG_ADMIN', password: 'must-not-accept' },
  ])('rejects an invalid manager: %j', async value => {
    await expect(validate(AddCompanyManagerDto, value)).rejects.toBeInstanceOf(BadRequestException);
  });
});
