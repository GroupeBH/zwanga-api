import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPhoneVerificationDto } from './dto/admin-phone-verification.dto';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ROLES_KEY } from '../common/guards/roles.guard';

const admin = { id: 'admin', role: UserRole.ADMIN, isActive: true, status: UserStatus.ACTIVE };
const user = { id: 'user', role: UserRole.PASSENGER, phone: '+243810000000', isPhoneVerified: false, isActive: true, status: UserStatus.PENDING_KYC };
const input = { phone: '0810000000', reason: 'Contrôle au bureau avec le titulaire.' };

function fixture(actor: any = admin, account: any = user) {
  const repository = {
    findOne: jest.fn().mockResolvedValueOnce(actor).mockResolvedValueOnce(account),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const service = Object.create(AdminService.prototype) as AdminService;
  const logger = { log: jest.fn(), warn: jest.fn() };
  Object.assign(service, { userRepository: repository, logger });
  return { service, repository, logger };
}

describe('Manual phone verification', () => {
  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('allows %s to verify only the existing phone, without changing PIN, KYC, role or status', async (role) => {
    const f = fixture({ ...admin, role });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).resolves.toEqual({ userId: 'user', phone: user.phone, isPhoneVerified: true });
    expect(f.repository.update).toHaveBeenCalledWith(
      { id: 'user', phone: user.phone, role: user.role, isPhoneVerified: false },
      { isPhoneVerified: true },
    );
    expect(f.logger.warn).toHaveBeenCalledWith({ event: 'admin.phone.manually_verified', actorUserId: 'admin', targetUserId: 'user', reason: input.reason });
  });

  it.each([UserRole.PASSENGER, UserRole.DRIVER, UserRole.MARKETER])('denies a %s actor', async (role) => {
    const f = fixture({ ...admin, role });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it.each([{ isActive: false }, { status: UserStatus.SUSPENDED }, { status: UserStatus.INACTIVE }])('denies an inactive administrator: %j', async (state) => {
    const f = fixture({ ...admin, ...state });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.MARKETER])('requires a super-admin for a back-office target (%s)', async (role) => {
    const f = fixture(admin, { ...user, role });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.repository.update).not.toHaveBeenCalled();
    const elevated = fixture({ ...admin, role: UserRole.SUPER_ADMIN }, { ...user, role });
    await expect(elevated.service.verifyUserPhone('user', 'admin', input)).resolves.toHaveProperty('isPhoneVerified', true);
  });

  it('rejects a stale phone from an open admin tab', async () => {
    const f = fixture(admin, { ...user, phone: '+243820000000' });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).rejects.toBeInstanceOf(ConflictException);
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it('does not verify a phone changed concurrently', async () => {
    const f = fixture();
    f.repository.update.mockResolvedValueOnce({ affected: 0 });
    f.repository.findOne.mockResolvedValueOnce({ ...user, phone: '+243820000000' });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).rejects.toBeInstanceOf(ConflictException);
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it('is idempotent if the same phone was already verified', async () => {
    const f = fixture(admin, { ...user, isPhoneVerified: true });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).resolves.toHaveProperty('isPhoneVerified', true);
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it('accepts a simultaneous successful verification of the same phone', async () => {
    const f = fixture();
    f.repository.update.mockResolvedValueOnce({ affected: 0 });
    f.repository.findOne.mockResolvedValueOnce({ ...user, isPhoneVerified: true });
    await expect(f.service.verifyUserPhone('user', 'admin', input)).resolves.toHaveProperty('isPhoneVerified', true);
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it('requires an existing account with a phone and a meaningful reason', async () => {
    await expect(fixture(admin, null).service.verifyUserPhone('user', 'admin', input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(fixture(admin, { ...user, phone: null }).service.verifyUserPhone('user', 'admin', input)).rejects.toBeInstanceOf(BadRequestException);
    const f = fixture();
    await expect(f.service.verifyUserPhone('user', 'admin', { ...input, reason: ' '.repeat(30) })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it('protects the endpoint and uses the actor from the authenticated request', async () => {
    const handler = AdminController.prototype.verifyUserPhone;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(JwtAuthGuard);
    const service = { verifyUserPhone: jest.fn() };
    const controller = new AdminController(service as any, {} as any, {} as any);
    await controller.verifyUserPhone({ user: { userId: 'actor-from-jwt' } }, 'target', input);
    expect(service.verifyUserPhone).toHaveBeenCalledWith('target', 'actor-from-jwt', input);
  });

  it('validates the payload and rejects forged verification/actor fields', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    const metadata = { type: 'body' as const, metatype: AdminPhoneVerificationDto };
    await expect(pipe.transform({ ...input, reason: ' '.repeat(20) }, metadata)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...input, isPhoneVerified: true, adminId: 'forged' }, metadata)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...input, reason: `  ${input.reason}  ` }, metadata)).resolves.toMatchObject(input);
  });
});
