import {
  BadGatewayException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import type { Server } from 'node:http';
import supertest from 'supertest';
import { AdminPaymentReconciliationService } from './admin-payment-reconciliation.service';
import { AdminPaymentsController } from './admin-payments.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserRole } from '../users/entities/user.entity';
import { PaymentsService } from '../payments/payments.service';
import { PaymentPurpose } from '../payments/entities/payment-transaction.entity';

describe('Admin payment reconciliation without resubmission', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const fixture = () => {
    const payment = {
      id: 'payment',
      status: 'pending',
      orderNumber: 'existing-order',
      paidAt: null,
      updatedAt: new Date(),
      phone: 'private',
      rawCheckResponse: { secret: 'private' },
    };
    const payments = {
      findTransactionById: jest.fn().mockResolvedValue(payment),
      reconcilePayment: jest.fn().mockResolvedValue(false),
      initiatePayment: jest.fn(),
      initiatePayout: jest.fn(),
    };
    const users = {
      findOne: jest
        .fn()
        .mockResolvedValue({ role: UserRole.SUPER_ADMIN, isActive: true }),
    };
    return {
      payment,
      payments,
      users,
      service: new AdminPaymentReconciliationService(
        payments as any,
        users as any,
      ),
    };
  };
  it.each([
    null,
    { role: UserRole.ADMIN },
    { role: UserRole.DRIVER },
    { role: UserRole.SUPER_ADMIN, passwordChangeRequired: true },
  ])(
    'rejects unauthorized actors before reading payments (%s)',
    async (actor) => {
      const f = fixture();
      f.users.findOne.mockResolvedValue(actor);
      await expect(
        f.service.reconcile('actor', 'payment'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.users.findOne).toHaveBeenCalledWith({
        where: { id: 'actor', isActive: true },
      });
      expect(f.payments.findTransactionById).not.toHaveBeenCalled();
      expect(f.payments.reconcilePayment).not.toHaveBeenCalled();
    },
  );
  it('returns 404 for a missing payment instead of the worker successful no-op', async () => {
    const f = fixture();
    f.payments.findTransactionById.mockRejectedValue(new NotFoundException());
    await expect(
      f.service.reconcile('actor', 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.payments.reconcilePayment).not.toHaveBeenCalled();
  });
  it.each(['pending', 'initiated', 'succeeded', 'failed', 'cancelled'])(
    'projects canonical %s status and distinguishes completed from paid',
    async (status) => {
      const f = fixture();
      f.payment.status = status;
      const completed = ['succeeded', 'failed', 'cancelled'].includes(status);
      f.payments.reconcilePayment.mockResolvedValue(completed);
      const result = await f.service.reconcile('actor', 'payment');
      expect(result).toMatchObject({
        paymentId: 'payment',
        status,
        completed,
        code: completed ? 'RECONCILED' : 'UNRESOLVED',
      });
      expect(result).not.toHaveProperty('phone');
      expect(result).not.toHaveProperty('rawCheckResponse');
      expect(f.payments.findTransactionById).toHaveBeenCalledTimes(2);
      expect(f.payments.reconcilePayment).toHaveBeenCalledWith('payment');
      expect(f.payments.initiatePayment).not.toHaveBeenCalled();
      expect(f.payments.initiatePayout).not.toHaveBeenCalled();
      if (status !== 'succeeded')
        expect(result.message).not.toContain('Paiement confirmé');
    },
  );
  it('explains missing provider order without declaring failure or releasing funds', async () => {
    const f = fixture();
    f.payment.orderNumber = '';
    expect(await f.service.reconcile('actor', 'payment')).toMatchObject({
      completed: false,
      code: 'MISSING_PROVIDER_ORDER',
      status: 'pending',
    });
  });
  it('propagates provider/settlement failures rather than announcing a false success', async () => {
    const f = fixture();
    const error = new BadGatewayException('Vérification FlexPay indisponible');
    f.payments.reconcilePayment.mockRejectedValue(error);
    await expect(f.service.reconcile('actor', 'payment')).rejects.toBe(error);
    expect(f.payments.initiatePayout).not.toHaveBeenCalled();
  });

  it.each([
    PaymentPurpose.WALLET_TOP_UP,
    PaymentPurpose.DRIVER_PAYOUT,
    PaymentPurpose.REFERRAL_PAYOUT,
  ])(
    'uses the existing %s provider check and settlement, never a payment initiation',
    async (purpose) => {
      const payment = {
        id: 'payment',
        provider: 'flexpay',
        purpose,
        status: 'pending',
        orderNumber: 'flex-order',
      };
      const flex = {
        checkTransaction: jest.fn().mockResolvedValue({}),
        checkPayoutTransaction: jest.fn().mockResolvedValue({}),
        initiatePayment: jest.fn(),
        initiatePayout: jest.fn(),
      };
      const settlement = { apply: jest.fn().mockResolvedValue(undefined) };
      const payments = new PaymentsService(
        { findOne: () => Promise.resolve(payment) } as any,
        {} as any,
        flex as any,
        {} as any,
        settlement as any,
      );
      // Provider-state persistence is covered by financial PostgreSQL tests.
      jest
        .spyOn(payments as any, 'applyFlexPayCheckResult')
        .mockResolvedValue({ ...payment, status: 'succeeded' });
      const f = fixture();
      const service = new AdminPaymentReconciliationService(
        payments,
        f.users as any,
      );
      expect((await service.reconcile('actor', 'payment')).completed).toBe(
        true,
      );
      expect(
        flex[
          purpose === PaymentPurpose.WALLET_TOP_UP
            ? 'checkTransaction'
            : 'checkPayoutTransaction'
        ],
      ).toHaveBeenCalledWith('flex-order');
      expect(
        flex[
          purpose === PaymentPurpose.WALLET_TOP_UP
            ? 'checkPayoutTransaction'
            : 'checkTransaction'
        ],
      ).not.toHaveBeenCalled();
      expect(settlement.apply).toHaveBeenCalledTimes(1);
      expect(flex.initiatePayment).not.toHaveBeenCalled();
      expect(flex.initiatePayout).not.toHaveBeenCalled();
    },
  );
});

describe('Admin reconciliation HTTP contract', () => {
  let app: INestApplication<Server>;
  const reconcile = jest
    .fn()
    .mockResolvedValue({ completed: false, status: 'pending' });
  const id = '00000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminPaymentsController],
      providers: [
        { provide: AdminPaymentReconciliationService, useValue: { reconcile } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const request = context
            .switchToHttp()
            .getRequest<
              Request & { user?: { userId: string; role: string } }
            >();
          const role = request.headers['x-test-role'];
          if (typeof role !== 'string') throw new UnauthorizedException();
          request.user = {
            userId: 'actor-from-auth',
            role,
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => reconcile.mockClear());
  it('requires authentication', async () => {
    await supertest(app.getHttpServer())
      .post(`/api/v1/admin/payments/${id}/reconcile`)
      .expect(401);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it.each(['passenger', 'driver', 'admin', 'marketer'])(
    'rejects role %s',
    async (role) => {
      await supertest(app.getHttpServer())
        .post(`/api/v1/admin/payments/${id}/reconcile`)
        .set('x-test-role', role)
        .expect(403);
      expect(reconcile).not.toHaveBeenCalled();
    },
  );
  it('validates UUIDs', async () => {
    await supertest(app.getHttpServer())
      .post('/api/v1/admin/payments/not-a-uuid/reconcile')
      .set('x-test-role', 'super_admin')
      .expect(400);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('accepts the existing admin URL, returns 200 and uses authenticated identity', async () => {
    const result = await supertest(app.getHttpServer())
      .post(`/api/v1/admin/payments/${id}/reconcile`)
      .set('x-test-role', 'super_admin')
      .send({ actorId: 'spoof', amount: 9999, phone: 'spoof' })
      .expect(200);
    expect(result.body).toEqual({ completed: false, status: 'pending' });
    expect(reconcile).toHaveBeenCalledWith('actor-from-auth', id);
  });
});
