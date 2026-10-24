import 'reflect-metadata';
import { Body, Controller, Get, INestApplication, Post, Req, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { Public } from './decorators/public.decorator';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { tokenFingerprint } from '../auth/token-fingerprint';
import { RegisterDto } from '../auth/dto/auth.dto';
import { UpdateProfileDto } from '../users/dto/user.dto';
import { UsersService } from '../users/users.service';
import { UserRole, UserStatus } from '../users/entities/user.entity';

// Real HTTP / Passport / guards / DTO pipeline; fake account storage only.
// Never import AppModule, load .env, send notifications or connect to providers.
@Controller('boundary-fixture')
class BoundaryFixtureController {
  @Get('identity')
  identity(@Req() req: { user: { userId: string; role: UserRole } }) {
    return { id: req.user.userId, role: req.user.role };
  }

  @Get('admin')
  @Roles(UserRole.ADMIN)
  admin() { return { allowed: true }; }

  @Get('super-admin')
  @Roles(UserRole.SUPER_ADMIN)
  superAdmin() { return { allowed: true }; }

  @Post('register')
  @Public()
  register(@Body() _dto: RegisterDto) { return { accepted: true }; }

  @Post('profile')
  profile(@Body() _dto: UpdateProfileDto) { return { accepted: true }; }
}

describe('isolated adversarial HTTP security boundaries', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'isolated-security-fixture-only' });
  const id = '00000000-0000-4000-8000-000000000099';
  let user: Record<string, unknown>;
  let token: string;
  const users = { findAuthIdentity: jest.fn(async () => user) };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BoundaryFixtureController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: 'isolated-security-fixture-only' }) },
        { provide: UsersService, useValue: users },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
      transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.init();
  });

  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    // Signed by our fixture key, but claiming a role the account does NOT have.
    token = jwt.sign({ sub: id, role: UserRole.SUPER_ADMIN }, { expiresIn: 60 });
    user = { id, role: UserRole.PASSENGER, isActive: true, status: UserStatus.ACTIVE,
      accessToken: tokenFingerprint(token), passwordChangeRequired: false };
    users.findAuthIdentity.mockClear();
  });

  it('uses the server-owned role, not the signed JWT role', async () => {
    await request(app.getHttpServer()).get('/boundary-fixture/identity')
      .auth(token, { type: 'bearer' }).expect(200, { id, role: UserRole.PASSENGER });
    await request(app.getHttpServer()).get('/boundary-fixture/admin')
      .auth(token, { type: 'bearer' }).expect(403);
  });

  it('refuses unsigned JWTs before reading account state', async () => {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${encode({ alg: 'none' })}.${encode({ sub: id, role: 'super_admin' })}.`;
    await request(app.getHttpServer()).get('/boundary-fixture/admin')
      .auth(unsigned, { type: 'bearer' }).expect(401);
    expect(users.findAuthIdentity).not.toHaveBeenCalled();
  });

  it.each([UserRole.PASSENGER, UserRole.DRIVER, UserRole.MARKETER])(
    'refuses admin routes to account role %s', async (role) => {
      user.role = role;
      await request(app.getHttpServer()).get('/boundary-fixture/admin').auth(token, { type: 'bearer' }).expect(403);
    },
  );

  it('separates administrator and super-administrator privileges', async () => {
    user.role = UserRole.ADMIN;
    await request(app.getHttpServer()).get('/boundary-fixture/admin').auth(token, { type: 'bearer' }).expect(200);
    await request(app.getHttpServer()).get('/boundary-fixture/super-admin').auth(token, { type: 'bearer' }).expect(403);
    user.role = UserRole.SUPER_ADMIN;
    await request(app.getHttpServer()).get('/boundary-fixture/super-admin').auth(token, { type: 'bearer' }).expect(200);
  });

  it('requires mandatory admin password change before privileged operations', async () => {
    Object.assign(user, { role: UserRole.SUPER_ADMIN, passwordChangeRequired: true });
    await request(app.getHttpServer()).get('/boundary-fixture/admin').auth(token, { type: 'bearer' }).expect(403);
  });

  it.each([
    { status: UserStatus.SUSPENDED }, { status: UserStatus.INACTIVE }, { isActive: false },
    { accessToken: null }, { accessToken: tokenFingerprint('different-session') },
  ])('denies stale or ineligible accounts: %j', async (patch) => {
    Object.assign(user, patch);
    await request(app.getHttpServer()).get('/boundary-fixture/identity').auth(token, { type: 'bearer' }).expect(401);
  });

  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.MARKETER])(
    'blocks public privilege escalation to %s at the DTO boundary', async (role) => {
      await request(app.getHttpServer()).post('/boundary-fixture/register').send({
        phone: '+243000000000', pin: '1234', firstName: 'Security', lastName: 'Fixture', role,
      }).expect(400);
      await request(app.getHttpServer()).post('/boundary-fixture/profile').auth(token, { type: 'bearer' })
        .send({ role }).expect(400);
    },
  );

  it.each(['accessToken', 'refreshToken', 'password', 'isPhoneVerified', 'isActive', 'status', 'kycStatus', 'balance', 'isDriver'])(
    'blocks mass assignment of %s in profile updates', async (field) => {
      await request(app.getHttpServer()).post('/boundary-fixture/profile').auth(token, { type: 'bearer' })
        .send({ [field]: true }).expect(400);
    },
  );
});
