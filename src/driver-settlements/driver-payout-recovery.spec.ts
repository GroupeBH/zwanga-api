import { BadRequestException, Logger } from '@nestjs/common';
import { DriverSettlementsService } from './driver-settlements.service';
import { DriverPayout, DriverPayoutStatus } from './entities/driver-payout.entity';
import { User } from '../users/entities/user.entity';
import { PaymentMethod, PaymentPurpose, PaymentStatus } from '../payments/entities/payment-transaction.entity';

describe('Driver payout reservation and recovery', () => {
  let service: DriverSettlementsService;
  let saved: any;
  let payment: any;
  let driverPhone: string;
  let approved: boolean;
  let payments: any;
  let manager: any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    saved = null;
    payment = null;
    driverPhone = '0891234567';
    approved = true;
    let balanceRead = 0;
    manager = {
      findOne: jest.fn(async (entity) => entity === User ? { id: 'driver-A', phone: driverPhone } : saved),
      exists: jest.fn(async () => approved),
      create: jest.fn((_entity, data) => ({ ...data, id: 'payout-A' })),
      save: jest.fn(async (data) => { saved = { ...data, paymentTransaction: payment }; return saved; }),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(async () => ({ sum: (++balanceRead % 2) === 1 ? '10000' :
          saved && ['pending', 'initiated', 'succeeded'].includes(saved.status) ? String(saved.amount) : '0' })),
      })),
    };
    payments = {
      findLatestTransactionForRelatedEntity: jest.fn(async () => payment),
      initiatePayout: jest.fn(async (input) => {
        payment = { ...input, id: 'payment-A', purpose: PaymentPurpose.DRIVER_PAYOUT,
          method: PaymentMethod.MOBILE_MONEY, status: PaymentStatus.INITIATED,
          orderNumber: 'ORDER-A', reference: 'REF-A' };
        return payment;
      }),
      checkPaymentStatus: jest.fn(async () => payment),
      handleFlexPayCallback: jest.fn(async () => payment),
      formatLogPayload: () => '{}', formatPaymentLogResponse: () => ({}),
    };
    service = new DriverSettlementsService(
      {} as any, { find: async () => saved ? [saved] : [] } as any, {} as any, {} as any, {} as any, {} as any,
      { get: () => undefined } as any, payments,
      { transaction: async (work) => work(manager) } as any, {} as any,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  const dto = { amount: 9500, idempotencyKey: '00000000-0000-4000-8000-000000000001' };

  it('normalizes the profile phone before reservation and preserves the driver account lock', async () => {
    const payout = await service.requestPayout('driver-A', dto);
    expect(payout.phone).toBe('+243891234567');
    expect(manager.findOne).toHaveBeenCalledWith(User, expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
    expect(payments.initiatePayout).toHaveBeenCalledWith(expect.objectContaining({ phone: '+243891234567', amount: 9500 }));
  });

  it('does not reserve funds for an invalid phone', async () => {
    driverPhone = 'invalid';
    await expect(service.requestPayout('driver-A', dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('keeps identity verification mandatory', async () => {
    approved = false;
    await expect(service.requestPayout('driver-A', dto)).rejects.toThrow('Votre identité');
    expect(payments.initiatePayout).not.toHaveBeenCalled();
  });

  it('reuses the same payout despite equivalent legacy phone representations', async () => {
    await service.requestPayout('driver-A', dto);
    saved.phone = '0891234567';
    const replay = await service.requestPayout('driver-A', { ...dto, phone: '+243891234567' });
    expect(replay.id).toBe('payout-A');
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it('marks a definitive rejection failed and releases its reserved amount', async () => {
    payments.initiatePayout.mockImplementation(async (input) => {
      payment = { ...input, id: 'payment-A', purpose: PaymentPurpose.DRIVER_PAYOUT,
        status: PaymentStatus.FAILED, providerMessage: 'Le service de versement Zwanga est indisponible.', orderNumber: null };
      throw new BadRequestException('Le service de versement Zwanga est indisponible.');
    });
    await expect(service.requestPayout('driver-A', dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(saved.status).toBe(DriverPayoutStatus.FAILED);
    expect(await (service as any).getAvailableBalanceWithManager(manager, 'driver-A')).toBe(10000);
  });

  it('keeps a delivery-uncertain payout without order number reserved even when old', async () => {
    await service.requestPayout('driver-A', dto);
    payment.status = PaymentStatus.PENDING;
    payment.orderNumber = null;
    saved.requestedAt = new Date(0);
    const replay = await service.requestPayout('driver-A', dto);
    expect(replay.requiresReview).toBe(true);
    expect(replay.reference).toBe('REF-A');
    expect(replay.paymentMessage).toContain('assistance');
    await service.reconcilePendingPayouts();
    expect(saved.status).toBe(DriverPayoutStatus.PENDING);
    expect(payments.checkPaymentStatus).not.toHaveBeenCalled();
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
    expect(await (service as any).getAvailableBalanceWithManager(manager, 'driver-A')).toBe(500);
  });

  it('does not downgrade a succeeded payout on a repeated stale callback', async () => {
    await service.requestPayout('driver-A', dto);
    payment.status = PaymentStatus.SUCCEEDED;
    expect((await service.handlePayoutCallback({ reference: 'REF-A' })).status).toBe(DriverPayoutStatus.SUCCEEDED);
    payment.status = PaymentStatus.PENDING;
    expect((await service.handlePayoutCallback({ reference: 'REF-A' })).status).toBe(DriverPayoutStatus.SUCCEEDED);
    expect(payments.initiatePayout).toHaveBeenCalledTimes(1);
  });
});
