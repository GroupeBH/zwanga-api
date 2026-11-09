import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { CreateFieldAgentDto } from './partners.dto';
import { PartnersService } from './partners.service';
import * as bcrypt from 'bcrypt';

const userId = '22222222-2222-4222-8222-222222222222';
const organizationId = '11111111-1111-4111-8111-111111111111';
const existingUser = { id: userId, firstName: 'Alice', lastName: 'Ilunga', phone: '+243812345678', password: 'existing-hash', role: UserRole.PASSENGER, status: UserStatus.ACTIVE, isActive: true };
const newAccount: CreateFieldAgentDto = { accountMode: 'new', firstName: ' Alice ', lastName: ' Ilunga ', phone: '0812345678', initialPin: '1234' };

function fixture(user: any = { ...existingUser }, member: any = null) {
  const userRepo = { findOne: jest.fn().mockResolvedValue(user), create: jest.fn(value => value), save: jest.fn(async value => ({ id: userId, ...value })) };
  const memberRepo = { findOneBy: jest.fn().mockResolvedValue(member), create: jest.fn(value => value), save: jest.fn(async value => value) };
  const transaction = jest.fn(async fn => fn({ getRepository: entity => entity === User ? userRepo : memberRepo }));
  const organizations = { findOneBy: jest.fn().mockResolvedValue({ id: organizationId, status: 'ACTIVE', partnerTypes: [{ type: 'FIELD_MARKETING', status: 'ACTIVE' }] }), manager: { transaction } };
  const service = new PartnersService(organizations as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { service, userRepo, memberRepo, transaction, organizations };
}

describe('Field agent account selection', () => {
  it('links by immutable user ID without changing the account, PIN or application role', async () => {
    const f = fixture();
    const result = await f.service.createFieldAgent(organizationId, { accountMode: 'existing', userId, role: 'FIELD_SUPERVISOR' });
    expect(f.userRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: userId }, lock: { mode: 'pessimistic_write' } }));
    expect(f.userRepo.save).not.toHaveBeenCalled();
    expect(f.memberRepo.save).toHaveBeenCalledWith(expect.objectContaining({ userId, organizationId, role: 'FIELD_SUPERVISOR', status: 'ACTIVE' }));
    expect(result).toEqual({ userId, name: 'Alice Ilunga', phone: '+243812345678', role: 'FIELD_SUPERVISOR', status: 'ACTIVE' });
    expect(result).not.toHaveProperty('password');
  });

  it('does not create a replacement for an unknown or deleted selected user', async () => {
    const f = fixture(null);
    await expect(f.service.createFieldAgent(organizationId, { accountMode: 'existing', userId })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.userRepo.save).not.toHaveBeenCalled();
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it.each([
    { isActive: false }, { status: UserStatus.INACTIVE }, { status: UserStatus.SUSPENDED },
    { role: UserRole.ADMIN }, { role: UserRole.SUPER_ADMIN }, { role: UserRole.MARKETER },
  ])('refuses an ineligible selected account: %j', async override => {
    const f = fixture({ ...existingUser, ...override });
    await expect(f.service.createFieldAgent(organizationId, { userId })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it.each([{ password: null }, { phone: null }])('requires existing login credentials without setting them implicitly: %j', async override => {
    const f = fixture({ ...existingUser, ...override });
    await expect(f.service.createFieldAgent(organizationId, { userId })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.userRepo.save).not.toHaveBeenCalled();
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it.each([
    { accountMode: 'existing' },
    { accountMode: 'new', userId },
    { userId, initialPin: '4321' },
    { userId, phone: '+243812345678' },
    { userId, firstName: 'Another' },
    { userId, lastName: 'Another' },
  ])('rejects an ambiguous selection before any write: %j', async dto => {
    const f = fixture();
    await expect(f.service.createFieldAgent(organizationId, dto as CreateFieldAgentDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('creates a new normal user and a scoped membership together', async () => {
    const f = fixture(null);
    await f.service.createFieldAgent(organizationId, newAccount);
    const saved = f.userRepo.save.mock.calls[0][0];
    expect(saved).toMatchObject({ firstName: 'Alice', lastName: 'Ilunga', phone: '+243812345678', role: UserRole.PASSENGER, isPhoneVerified: false });
    expect(await bcrypt.compare('1234', saved.password)).toBe(true);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.memberRepo.save).toHaveBeenCalledTimes(1);
  });

  it('requires a PIN for the explicit new account mode', async () => {
    const f = fixture(null);
    await expect(f.service.createFieldAgent(organizationId, { ...newAccount, initialPin: undefined })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('does not silently link an existing phone in new account mode', async () => {
    const f = fixture();
    await expect(f.service.createFieldAgent(organizationId, newAccount)).rejects.toBeInstanceOf(ConflictException);
    expect(f.userRepo.save).not.toHaveBeenCalled();
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it('preserves legacy phone-based clients and never replaces an existing PIN', async () => {
    const f = fixture();
    await expect(f.service.createFieldAgent(organizationId, { ...newAccount, accountMode: undefined })).resolves.toMatchObject({ userId });
    expect(f.userRepo.save).not.toHaveBeenCalled();
  });

  it('rejects a duplicate membership and permits rejoining a removed membership', async () => {
    const active = fixture(existingUser, { userId, organizationId, status: 'ACTIVE' });
    await expect(active.service.createFieldAgent(organizationId, { userId })).rejects.toBeInstanceOf(ConflictException);
    expect(active.memberRepo.save).not.toHaveBeenCalled();
    const removed = fixture(existingUser, { id: 'membership', userId, organizationId, status: 'REMOVED' });
    await removed.service.createFieldAgent(organizationId, { userId });
    expect(removed.memberRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'membership', status: 'ACTIVE' }));
  });

  it('reports concurrent duplicate creation as a conflict rather than an internal error', async () => {
    const f = fixture(null);
    f.userRepo.save.mockRejectedValue({ code: '23505' });
    await expect(f.service.createFieldAgent(organizationId, newAccount)).rejects.toBeInstanceOf(ConflictException);
    expect(f.memberRepo.save).not.toHaveBeenCalled();
  });

  it('does not attach a selected user to an inactive or non-field organization', async () => {
    const f = fixture();
    f.organizations.findOneBy.mockResolvedValue(null);
    await expect(f.service.createFieldAgent(organizationId, { userId })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.transaction).not.toHaveBeenCalled();
  });
});

describe('Field agent DTO validation', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const validate = (value: unknown) => pipe.transform(value, { type: 'body', metatype: CreateFieldAgentDto });
  it.each([{ accountMode: 'existing', userId }, { userId }, newAccount, { ...newAccount, accountMode: undefined, initialPin: undefined }])('accepts supported account contracts: %j', async value => {
    await expect(validate(value)).resolves.toBeInstanceOf(CreateFieldAgentDto);
  });
  it.each([
    {}, { accountMode: 'existing' }, { userId: 'invalid' }, { userId: null },
    { ...newAccount, initialPin: undefined }, { ...newAccount, initialPin: null },
    { ...newAccount, initialPin: 'abcd' }, { ...newAccount, phone: 'invalid' },
    { accountMode: 'other', userId }, { userId, role: 'ORG_ADMIN' },
    { userId, password: 'must-not-accept' },
  ])('rejects invalid input: %j', async value => {
    await expect(validate(value)).rejects.toBeInstanceOf(BadRequestException);
  });
});
