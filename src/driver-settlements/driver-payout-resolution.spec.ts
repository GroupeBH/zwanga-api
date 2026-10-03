import {
  BadGatewayException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Reflector } from '@nestjs/core';
import { DriverPayoutRecoveryService } from './driver-payout-recovery.service';
import { DriverSettlementsService } from './driver-settlements.service';
import { DriverPayout } from './entities/driver-payout.entity';
import { DriverPayoutEvent } from './entities/driver-payout-event.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { User, UserRole } from '../users/entities/user.entity';
import {
  payoutRecoveryState,
  payoutReviewDelay,
} from './driver-payout-recovery.policy';
import { ResolveDriverPayoutDto } from './dto/driver-payout-recovery.dto';
import { AdminDriverPayoutRecoveryController } from './driver-payout-recovery.controller';
import { RolesGuard } from '../common/guards/roles.guard';

describe('Driver payout support resolution', () => {
  let payout: any,
    payment: any,
    events: any[],
    manager: any,
    payments: any,
    source: any;
  let service: DriverPayoutRecoveryService,
    settlements: DriverSettlementsService;
  const dto = {
    expectedReference: 'DRVREF',
    confirmedNotPaid: true as const,
    reason: 'Confirmation écrite du prestataire',
    evidenceReference: 'FLEX-TICKET-12345',
  };
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    payout = {
      id: 'payout',
      driverId: 'driver',
      amount: 9500,
      currency: 'CDF',
      status: 'pending',
      requestedAt: new Date(Date.now() - 14 * 24 * 3600_000),
      createdAt: new Date(0),
      phone: '+243891234567',
      paymentTransactionId: 'payment',
      recoveryBlocked: false,
    };
    payment = {
      id: 'payment',
      userId: 'driver',
      purpose: 'driver_payout',
      relatedEntityType: 'driver_payout',
      relatedEntityId: 'payout',
      amount: 9500,
      currency: 'CDF',
      status: 'pending',
      provider: 'flexpay',
      reference: 'DRVREF',
      orderNumber: null,
    };
    events = [];
    const repository = {
      findOne: jest.fn(async ({ where }) =>
        where.id === payout.id &&
        (!where.driverId || where.driverId === payout.driverId)
          ? { ...payout }
          : null,
      ),
    };
    manager = {
      findOne: jest.fn(async (entity) =>
        entity === User
          ? { id: 'driver' }
          : entity === DriverPayout
            ? { ...payout }
            : payment
              ? { ...payment }
              : null,
      ),
      save: jest.fn(async (entityOrValue, value) => {
        const row = value ?? entityOrValue;
        if (entityOrValue === DriverPayoutEvent) events.push(row);
        else payout = { ...row };
        return { ...row };
      }),
      create: jest.fn((_entity, data) => ({ ...data })),
    };
    source = {
      getRepository: () => repository,
      transaction: async (work) => work(manager),
    };
    payments = {
      findLatestTransactionForRelatedEntity: jest.fn(async () =>
        payment ? { ...payment } : null,
      ),
      reconcileFlexPayDriverPayout: jest.fn(async () => ({ ...payment })),
      initiatePayout: jest.fn(),
    };
    const config = { get: () => undefined };
    settlements = new DriverSettlementsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      config as any,
      payments,
      source,
      {} as any,
    );
    service = new DriverPayoutRecoveryService(
      source,
      payments,
      settlements,
      config as any,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('flags old payouts even when they have a provider order number', () => {
    expect(
      payoutRecoveryState(payout, { ...payment, orderNumber: 'ORDER' }, 1440),
    ).toMatchObject({
      isStale: true,
      requiresReview: true,
      canRequestReview: true,
    });
    expect(payoutReviewDelay('invalid')).toBe(1440);
    expect(payoutReviewDelay('1')).toBe(1440);
  });

  it('records one review request on repeated taps without releasing or sending money', async () => {
    await service.requestReview('driver', 'payout', 'Retrait non reçu');
    const response = await service.requestReview(
      'driver',
      'payout',
      'Retrait non reçu',
    );
    expect(events).toHaveLength(1);
    expect(response).toMatchObject({
      status: 'pending',
      reviewStatus: 'requested',
      canRequestReview: false,
    });
    expect(payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('does not expose or change another driver payout', async () => {
    await expect(
      service.requestReview('other', 'payout', 'Retrait non reçu'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.refresh('payout', 'other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('only the admin role can reach support resolution', () => {
    const guard = new RolesGuard(new Reflector());
    const context = (role: UserRole) =>
      ({
        getClass: () => AdminDriverPayoutRecoveryController,
        getHandler: () => AdminDriverPayoutRecoveryController.prototype.resolve,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as any;
    expect(() => guard.canActivate(context(UserRole.DRIVER))).toThrow();
    expect(guard.canActivate(context(UserRole.ADMIN))).toBe(true);
  });

  it('rejects absent proof and string booleans at the HTTP boundary', async () => {
    for (const body of [
      { ...dto, evidenceReference: '   ' },
      { ...dto, confirmedNotPaid: 'true' },
      { ...dto, reason: ' ' },
      { ...dto, confirmedNotPaid: false },
    ]) {
      expect(
        (await validate(plainToInstance(ResolveDriverPayoutDto, body))).length,
      ).toBeGreaterThan(0);
    }
  });

  it('releases exactly once, preserves provider truth and records operator and evidence', async () => {
    await service.resolveNotPaid('admin', 'payout', dto);
    const response = await service.resolveNotPaid('admin', 'payout', dto);
    expect(response).toMatchObject({
      status: 'cancelled',
      canRetry: true,
      reviewStatus: 'resolved',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: 'admin',
      evidenceReference: dto.evidenceReference,
    });
    expect(payment.status).toBe('pending');
    expect(payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('does not interpret provider pending as an automatic cancellation', async () => {
    payment.orderNumber = 'ORDER';
    await service.refresh('payout', 'driver');
    expect(payout.status).toBe('pending');
    expect(payout.fundsReleasedAt).toBeUndefined();
  });

  it('permits audited out-of-band proof during a provider check outage', async () => {
    payment.orderNumber = 'ORDER';
    payments.reconcileFlexPayDriverPayout.mockRejectedValue(
      new BadGatewayException(),
    );
    expect((await service.resolveNotPaid('admin', 'payout', dto)).status).toBe(
      'cancelled',
    );
  });

  it.each([
    'succeeded',
    'recent',
    'wrong-reference',
    'wrong-amount',
    'pawapay',
  ])('refuses unsafe resolution: %s', async (scenario) => {
    if (scenario === 'succeeded') payment.status = 'succeeded';
    if (scenario === 'recent') payout.requestedAt = new Date();
    if (scenario === 'wrong-reference') payment.reference = 'DIFFERENT';
    if (scenario === 'wrong-amount') payment.amount = 1;
    if (scenario === 'pawapay') payment.provider = 'pawapay';
    await expect(
      service.resolveNotPaid('admin', 'payout', dto),
    ).rejects.toThrow();
    expect(events).toHaveLength(0);
    expect(payout.status).toBe('pending');
  });

  it('re-reads success under the lock, not the stale pre-check result', async () => {
    manager.findOne.mockImplementation(async (entity) =>
      entity === User
        ? { id: 'driver' }
        : entity === DriverPayout
          ? { ...payout }
          : { ...payment, status: 'succeeded' },
    );
    await expect(
      service.resolveNotPaid('admin', 'payout', dto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(events).toHaveLength(0);
  });

  it('ignores stale pending after release but records late success and blocks further withdrawals', async () => {
    await service.resolveNotPaid('admin', 'payout', dto);
    await settlements.applyPaymentToPayout(payment);
    expect(payout.status).toBe('cancelled');
    payment.status = 'succeeded';
    await settlements.applyPaymentToPayout(payment);
    await settlements.applyPaymentToPayout(payment);
    expect(payout).toMatchObject({
      status: 'succeeded',
      recoveryBlocked: true,
    });
    expect(events.filter((e) => e.action === 'late_success')).toHaveLength(1);
    await service.closeLateSuccessIncident('admin', 'payout', {
      reason: 'Solde rapproché',
      evidenceReference: 'CASE-RECONCILED',
    });
    expect(payout).toMatchObject({
      status: 'succeeded',
      recoveryBlocked: false,
    });
    expect(events.at(-1).action).toBe('late_success_review_closed');
  });
});
