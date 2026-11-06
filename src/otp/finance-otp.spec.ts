import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { FinanceOtpService, financeIntent } from './finance-otp.service';
import type { FinanceAction } from './finance-otp.service';
import { FinanceOtpGuard } from './finance-otp.guard';
import { OtpService } from './otp.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { AdminFinanceOtpController } from '../admin/admin-finance-otp.controller';
import { AdminDirectPayoutController } from '../admin/admin-direct-payout.controller';
import { AdminDirectPayoutService } from '../admin/admin-direct-payout.service';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { AdminReferralsService } from '../admin/admin-referrals.service';
import { TripStatementService } from '../admin/trip-statement.service';
import { AdminDriverPayoutRecoveryController } from '../driver-settlements/driver-payout-recovery.controller';
import { DriverPayoutRecoveryService } from '../driver-settlements/driver-payout-recovery.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

const targetId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const direct = {
  idempotencyKey: targetId,
  phone: '+243891234567',
  amount: 10000,
  currency: 'CDF',
  reason: 'Operation de test',
  confirmed: true,
};
const retry = {
  reason: 'Relance de test',
  expectedReference: 'TEST-ORDER',
  evidenceReference: 'TEST-PROOF',
  confirmedNotPaid: true,
  confirmedNotReceived: true,
};

describe('financial OTP intent binding', () => {
  it('binds every direct payout field and ignores only the code itself', () => {
    const hash = financeIntent('direct_payout', direct);
    expect(
      financeIntent('direct_payout', { ...direct, otpCode: '123456' }),
    ).toBe(hash);
    expect(
      financeIntent('direct_payout', {
        ...direct,
        reason: ` ${direct.reason} `,
      }),
    ).toBe(hash);
    for (const patch of [
      { idempotencyKey: otherId },
      { phone: '+243891234568' },
      { amount: 10001 },
      { reason: 'Autre motif' },
    ])
      expect(financeIntent('direct_payout', { ...direct, ...patch })).not.toBe(
        hash,
      );
    for (const patch of [
      { currency: 'USD' },
      { confirmed: false },
      { amount: '10000' },
      { actorId: 'spoof' },
    ])
      expect(() =>
        financeIntent('direct_payout', { ...direct, ...patch }),
      ).toThrow();
  });
  it('binds withdrawal, action and non-execution evidence', () => {
    const hash = financeIntent('driver_payout_retry', retry, targetId);
    expect(
      financeIntent('referral_withdrawal_retry', retry, targetId),
    ).not.toBe(hash);
    expect(financeIntent('driver_payout_retry', retry, otherId)).not.toBe(hash);
    for (const field of ['reason', 'expectedReference', 'evidenceReference'])
      expect(
        financeIntent(
          'driver_payout_retry',
          { ...retry, [field]: 'DIFFERENT' },
          targetId,
        ),
      ).not.toBe(hash);
    expect(() => financeIntent('driver_payout_retry', retry)).toThrow();
    expect(() =>
      financeIntent(
        'driver_payout_retry',
        { ...retry, confirmedNotReceived: false },
        targetId,
      ),
    ).toThrow();
  });
});

describe('financial step-up on real HTTP controllers (no SMS or payment network)', () => {
  let app: INestApplication;
  const actor = {
    id: 'actor',
    role: UserRole.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    isActive: true,
    passwordChangeRequired: false,
    phone: '+243900000001',
  };
  const users = { findOne: jest.fn() };
  // Redis atomic consumption/concurrency is verified separately on disposable Redis.
  const challenges = new Set<string>();
  const otp = {
    sendOtp: jest.fn(async (phone, purpose, binding) => {
      challenges.add(JSON.stringify([phone, purpose, binding]));
      return { success: true, codeLength: 6, expiresInSeconds: 900 };
    }),
    verifyOtp: jest.fn(async (phone, code, purpose, binding) => ({
      valid:
        code === '123456' &&
        challenges.delete(JSON.stringify([phone, purpose, binding])),
    })),
  };
  const create = jest.fn().mockResolvedValue({ status: 'pending' });
  const driverRetry = jest.fn().mockResolvedValue({ status: 'pending' });
  const referralRetry = jest.fn().mockResolvedValue({ status: 'pending' });
  const routes: [FinanceAction, string, Record<string, unknown>, jest.Mock][] =
    [
      ['direct_payout', '/admin/payments/direct-payouts', direct, create],
      [
        'driver_payout_retry',
        `/admin/driver-payouts/${targetId}/retry`,
        retry,
        driverRetry,
      ],
      [
        'referral_withdrawal_retry',
        `/admin/referrals/withdrawals/${targetId}/retry`,
        retry,
        referralRetry,
      ],
    ];
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        AdminFinanceOtpController,
        AdminDirectPayoutController,
        AdminDriverPayoutRecoveryController,
        AdminController,
      ],
      providers: [
        FinanceOtpService,
        FinanceOtpGuard,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: OtpService, useValue: otp },
        { provide: AdminDirectPayoutService, useValue: { create } },
        {
          provide: DriverPayoutRecoveryService,
          useValue: { retry: driverRetry },
        },
        {
          provide: AdminReferralsService,
          useValue: { retryWithdrawal: referralRetry },
        },
        { provide: AdminService, useValue: {} },
        { provide: TripStatementService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalGuards(
      {
        canActivate(ctx) {
          const req = ctx.switchToHttp().getRequest();
          if (!req.headers['x-role']) throw new UnauthorizedException();
          req.user = {
            userId: req.headers['x-actor'] || 'actor',
            role: req.headers['x-role'],
          };
          return true;
        },
      },
      new RolesGuard(new Reflector()),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    challenges.clear();
    users.findOne.mockResolvedValue(actor);
  });
  const send = (action: FinanceAction, payload: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/admin/finance/otp')
      .set('x-role', 'super_admin')
      .send({
        action,
        payload,
        ...(action === 'direct_payout' ? {} : { targetId }),
      });
  it.each(routes)(
    'protects %s and strips the code before financial execution',
    async (action, url, payload, execute) => {
      await request(app.getHttpServer()).post(url).send(payload).expect(401);
      await request(app.getHttpServer())
        .post(url)
        .set('x-role', 'admin')
        .send(payload)
        .expect(403);
      const absent = await request(app.getHttpServer())
        .post(url)
        .set('x-role', 'super_admin')
        .send(payload)
        .expect(403);
      expect(absent.body.code).toBe('FINANCE_OTP_REQUIRED');
      expect(execute).not.toHaveBeenCalled();
      const sent = await send(action, payload).expect(200);
      expect(sent.body.maskedPhone).toBe('***001');
      expect(sent.body).not.toHaveProperty('otpCode');
      expect(otp.sendOtp).toHaveBeenCalledWith(
        actor.phone,
        'admin_finance',
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
      await request(app.getHttpServer())
        .post(url)
        .set('x-role', 'super_admin')
        .send({ ...payload, otpCode: '654321' })
        .expect(403);
      await request(app.getHttpServer())
        .post(url)
        .set('x-role', 'super_admin')
        .send({ ...payload, reason: 'Changed operation', otpCode: '123456' })
        .expect(403);
      expect(execute).not.toHaveBeenCalled();
      const response = await request(app.getHttpServer())
        .post(url)
        .set('x-role', 'super_admin')
        .send({ ...payload, otpCode: '123456' });
      expect([200, 201]).toContain(response.status);
      expect(execute).toHaveBeenCalledTimes(1);
      const forwarded = execute.mock.calls[0].at(-1);
      expect(forwarded).toMatchObject(payload);
      // class-transformer can create an undefined optional field; no secret value
      // may reach the payout service or its serialized evidence.
      expect(forwarded.otpCode).toBeUndefined();
      expect(JSON.stringify(forwarded)).not.toContain('otpCode');
      await request(app.getHttpServer())
        .post(url)
        .set('x-role', 'super_admin')
        .send({ ...payload, otpCode: '123456' })
        .expect(403);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { role: UserRole.ADMIN },
    { isActive: false },
    { status: UserStatus.SUSPENDED },
    { passwordChangeRequired: true },
  ])('rechecks actor authorization in SQL before sending %j', async (patch) => {
    users.findOne.mockResolvedValue({ ...actor, ...patch });
    await send('direct_payout', direct).expect(403);
    expect(otp.sendOtp).not.toHaveBeenCalled();
  });
  it('does not accept the same phone/code from another actor', async () => {
    await send('direct_payout', direct).expect(200);
    users.findOne.mockResolvedValue({ ...actor, id: 'other' });
    await request(app.getHttpServer())
      .post(routes[0][1])
      .set('x-role', 'super_admin')
      .set('x-actor', 'other')
      .send({ ...direct, otpCode: '123456' })
      .expect(403);
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated sends and malformed intents before SMS', async () => {
    await request(app.getHttpServer())
      .post('/admin/finance/otp')
      .send({ action: 'direct_payout', payload: direct })
      .expect(401);
    await send('direct_payout', { ...direct, amount: -1 }).expect(400);
    expect(otp.sendOtp).not.toHaveBeenCalled();
  });
});
