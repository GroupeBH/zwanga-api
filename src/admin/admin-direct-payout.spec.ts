import {
  BadRequestException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { validateSync } from 'class-validator';
import supertest from 'supertest';
import { AdminDirectPayoutController } from './admin-direct-payout.controller';
import { AdminDirectPayoutService } from './admin-direct-payout.service';
import { AdminDirectPayoutDto } from './dto/admin-direct-payout.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { PaymentPurpose } from '../payments/entities/payment-transaction.entity';
import { PaymentSettlementRegistry } from '../payments/payment-settlement.registry';
import { PaymentsService } from '../payments/payments.service';

const key = '00000000-0000-4000-8000-000000000001';
const input = {
  idempotencyKey: key,
  phone: '+243891234567',
  amount: 10000,
  currency: 'CDF',
  reason: 'Frais opérationnels test',
  confirmed: true,
} as const;
describe('Direct treasury payout HTTP contract (mocked provider)', () => {
  let app: INestApplication;
  const create = jest
    .fn()
    .mockResolvedValue({ id: 'payment', status: 'pending' });
  const get = jest.fn().mockResolvedValue({ id: 'payment', status: 'pending' });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminDirectPayoutController],
      providers: [
        { provide: AdminDirectPayoutService, useValue: { create, get } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          if (!req.headers['x-test-role']) throw new UnauthorizedException();
          req.user = {
            userId: 'authenticated-actor',
            role: req.headers['x-test-role'],
            passwordChangeRequired: req.headers['x-test-password'] === 'yes',
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    create.mockClear();
    get.mockClear();
  });
  const url = '/api/v1/admin/payments/direct-payouts';
  it('rejects missing authentication', async () => {
    await supertest(app.getHttpServer()).post(url).send(input).expect(401);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['admin', 'driver', 'passenger', 'marketer'])(
    'rejects %s at both boundaries',
    async (role) => {
      await supertest(app.getHttpServer())
        .post(url)
        .set('x-test-role', role)
        .send(input)
        .expect(403);
      await supertest(app.getHttpServer())
        .get(`${url}/${key}`)
        .set('x-test-role', role)
        .expect(403);
      expect(create).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );
  it('requires the admin password change to be completed', async () => {
    await supertest(app.getHttpServer())
      .post(url)
      .set('x-test-role', 'super_admin')
      .set('x-test-password', 'yes')
      .send(input)
      .expect(403);
    expect(create).not.toHaveBeenCalled();
  });
  it('submits with the authenticated actor and does not label pending as paid', async () => {
    const response = await supertest(app.getHttpServer())
      .post(url)
      .set('x-test-role', 'super_admin')
      .send(input)
      .expect(200);
    expect(create).toHaveBeenCalledWith(
      'authenticated-actor',
      expect.objectContaining(input),
    );
    expect(response.body.status).toBe('pending');
  });
  it.each([
    { amount: -1 },
    { amount: 0 },
    { amount: 999999999 },
    { amount: 1.234 },
    { amount: '100' },
    { phone: 'bad' },
    { phone: '+243111111111' },
    { currency: 'USD' },
    { confirmed: false },
    { confirmed: 'true' },
    { idempotencyKey: 'bad' },
    { reason: '    ' },
    { actorId: 'spoof' },
    { userId: 'victim' },
    { callbackUrl: 'https://bad.invalid' },
    { purpose: 'driver_payout' },
  ])('rejects malformed or forged payload %j', async (patch) => {
    await supertest(app.getHttpServer())
      .post(url)
      .set('x-test-role', 'super_admin')
      .send({ ...input, ...patch })
      .expect(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('lookup never resubmits an order and validates its key', async () => {
    await supertest(app.getHttpServer())
      .get(`${url}/${key}`)
      .set('x-test-role', 'super_admin')
      .expect(200);
    expect(get).toHaveBeenCalledWith('authenticated-actor', key);
    expect(create).not.toHaveBeenCalled();
    await supertest(app.getHttpServer())
      .get(`${url}/bad`)
      .set('x-test-role', 'super_admin')
      .expect(400);
  });
});

describe('Treasury payout authorization and response safety', () => {
  it('does not allow a treasury transfer to go through a deposit operation', async () => {
    const payments = new PaymentsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      payments.initiatePayment({ purpose: PaymentPurpose.ADMIN_PAYOUT } as any),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each(['pending', 'initiated', 'failed', 'cancelled', 'succeeded'])(
    'treasury message does not describe user earnings (%s)',
    (status) => {
      const payments = new PaymentsService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      const message = payments.getClientPaymentMessage({
        purpose: PaymentPurpose.ADMIN_PAYOUT,
        status,
      } as any);
      expect(message).toContain('administratif');
      expect(message).not.toContain('gains');
    },
  );
  const fixture = () => {
    const actor = {
      role: UserRole.SUPER_ADMIN,
      isActive: true,
      passwordChangeRequired: false,
      status: UserStatus.ACTIVE,
    };
    const payment = {
      id: 'payment',
      userId: 'actor',
      relatedEntityId: key,
      amount: 10000,
      currency: 'CDF',
      phone: input.phone,
      description: input.reason,
      status: 'pending',
      rawInitiationResponse: { secret: 'private' },
    };
    const payments = { initiatePayout: jest.fn().mockResolvedValue(payment) };
    const users = { findOneBy: jest.fn().mockResolvedValue(actor) };
    const repo = { findOneBy: jest.fn().mockResolvedValue(payment) };
    const service = new AdminDirectPayoutService(
      payments as any,
      users as any,
      repo as any,
    );
    return { service, payments, users, repo, payment, actor };
  };
  it.each([
    { role: UserRole.ADMIN },
    { isActive: false },
    { passwordChangeRequired: true },
    { status: UserStatus.SUSPENDED },
    { status: UserStatus.INACTIVE },
  ])('fresh authorization rejects %j before send', async (patch) => {
    const f = fixture();
    f.users.findOneBy.mockResolvedValue({ ...f.actor, ...patch });
    await expect(f.service.create('actor', input)).rejects.toMatchObject({
      status: 403,
    });
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });
  it('records the actor, key, phone and reason without exposing provider payloads', async () => {
    const f = fixture();
    const output = await f.service.create('actor', input);
    expect(f.payments.initiatePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'actor',
        purpose: PaymentPurpose.ADMIN_PAYOUT,
        relatedEntityType: 'admin_direct_payout',
        relatedEntityId: key,
        phone: input.phone,
        amount: 10000,
        description: input.reason,
        preferredProvider: 'flexpay',
      }),
    );
    expect(output.actorId).toBe('actor');
    expect(output).not.toHaveProperty('rawInitiationResponse');
  });
  it('returns a recorded rejection or uncertain result without retrying', async () => {
    const f = fixture();
    f.payment.status = 'failed';
    f.payments.initiatePayout.mockRejectedValue(
      new BadRequestException('provider refused'),
    );
    expect((await f.service.create('actor', input)).status).toBe('failed');
    expect(f.payments.initiatePayout).toHaveBeenCalledTimes(1);
  });
  it('does not hide an idempotency conflict', async () => {
    const f = fixture();
    f.payments.initiatePayout.mockRejectedValue({ status: 409 });
    await expect(f.service.create('actor', input)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.repo.findOneBy).not.toHaveBeenCalled();
  });
  it('recovery re-reads without any provider send', async () => {
    const f = fixture();
    await f.service.get('actor', key);
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });
  it('does not settle treasury funds into any user wallet or referral balance', async () => {
    const registry = new PaymentSettlementRegistry();
    const settle = jest.fn();
    registry.register(PaymentPurpose.WALLET_TOP_UP, settle);
    registry.register(PaymentPurpose.REFERRAL_PAYOUT, settle);
    await registry.apply({
      purpose: PaymentPurpose.ADMIN_PAYOUT,
      status: 'succeeded',
    } as any);
    expect(settle).not.toHaveBeenCalled();
  });
  it('requires every DTO field including explicit confirmation', () => {
    for (const field of Object.keys(input)) {
      const value = { ...input };
      delete value[field];
      expect(
        validateSync(Object.assign(new AdminDirectPayoutDto(), value)).length,
      ).toBeGreaterThan(0);
    }
  });
});
