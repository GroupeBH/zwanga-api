import { BadGatewayException } from '@nestjs/common';
import { PawaPayOperationsService } from './pawapay-operations.service';
import {
  PawaPayRefund,
  PawaPayRefundStatus,
} from './entities/pawapay-refund.entity';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { PaymentGatewayUnavailableError } from './payment-provider.policy';

const depositId = '11111111-1111-4111-8111-111111111111';
const refundId = '22222222-2222-4222-8222-222222222222';
const otherRefundId = '33333333-3333-4333-8333-333333333333';
const actor = '44444444-4444-4444-8444-444444444444';

describe('PawaPay refund lifecycle', () => {
  let service: PawaPayOperationsService;
  let payment: PaymentTransaction;
  let refunds: Map<string, PawaPayRefund>;
  let pawa: any;
  let paymentService: any;

  beforeEach(() => {
    payment = {
      id: '55555555-5555-4555-8555-555555555555',
      orderNumber: depositId,
      reference: 'REF123',
      provider: PaymentProvider.PAWAPAY,
      purpose: PaymentPurpose.GENERIC,
      method: PaymentMethod.MOBILE_MONEY,
      status: PaymentStatus.SUCCEEDED,
      amount: 100,
      currency: 'CDF',
    } as PaymentTransaction;
    refunds = new Map();
    const manager = {
      transaction: jest.fn((run) => run(manager)),
      findOne: jest.fn(async (entity, options) =>
        entity === PaymentTransaction
          ? { ...payment }
          : refunds.get(options.where.id)
            ? { ...refunds.get(options.where.id) }
            : null,
      ),
      find: jest.fn(async (_entity, options) =>
        [...refunds.values()].filter(
          (item) =>
            item.paymentTransactionId === options.where.paymentTransactionId,
        ),
      ),
      create: jest.fn((_entity, value) => value),
      save: jest.fn(async (_entity, value) => {
        const saved = { ...value } as PawaPayRefund;
        refunds.set(saved.id, saved);
        return { ...saved };
      }),
    };
    const paymentRepo = {
      findOneByOrFail: jest.fn(async () => ({ ...payment })),
      findOneBy: jest.fn(async () => ({ ...payment })),
    };
    const refundRepo = {
      manager,
      findOneBy: jest.fn(async ({ id }) =>
        refunds.get(id) ? { ...refunds.get(id) } : null,
      ),
      find: jest.fn(async () => [...refunds.values()]),
    };
    pawa = {
      initiateRefund: jest.fn(async () => ({
        accepted: true,
        status: 'ACCEPTED',
        failureMessage: null,
        raw: { refundId, status: 'ACCEPTED' },
      })),
      checkRefund: jest.fn(async () => ({
        paymentId: refundId,
        status: 'COMPLETED',
        amount: '40',
        currency: 'CDF',
        clientReferenceId: payment.reference,
        raw: {
          status: 'FOUND',
          data: { refundId, status: 'COMPLETED', depositId },
        },
      })),
      normalizeCallback: jest.fn((_kind, payload) => ({
        paymentId: payload.refundId,
        status: payload.status,
      })),
      isConfigured: () => true,
    };
    paymentService = { checkPaymentStatus: jest.fn(async () => payment) };
    service = new PawaPayOperationsService(
      paymentRepo as any,
      refundRepo as any,
      pawa,
      paymentService,
      {
        get: (key) => (key === 'PAWAPAY_REFUNDS_ENABLED' ? 'true' : undefined),
      } as any,
    );
  });

  const dto = (id = refundId, amount = 40) => ({
    refundId: id,
    paymentTransactionId: '55555555-5555-4555-8555-555555555555',
    amount,
    reason: 'Remboursement approuvé',
  });

  it('persists the UUID before the financial POST and reuses it idempotently', async () => {
    pawa.initiateRefund.mockImplementationOnce(async (input) => {
      expect(refunds.get(input.refundId)?.status).toBe(
        PawaPayRefundStatus.CREATED,
      );
      expect(input.depositId).toBe(depositId);
      return { accepted: true, status: 'ACCEPTED', raw: {} };
    });
    expect((await service.createRefund(dto(), actor)).status).toBe(
      PawaPayRefundStatus.INITIATED,
    );
    await service.createRefund(dto(), actor);
    expect(pawa.initiateRefund).toHaveBeenCalledTimes(1);
  });

  it('reserves partial refunds and rejects an amount over the original deposit', async () => {
    await service.createRefund(dto(refundId, 60), actor);
    await service.createRefund(dto(otherRefundId, 40), actor);
    await expect(
      service.createRefund(
        dto('66666666-6666-4666-8666-666666666666', 0.29),
        actor,
      ),
    ).rejects.toThrow('dépasse le dépôt');
    expect(pawa.initiateRefund).toHaveBeenCalledTimes(2);
  });

  it('keeps uncertain delivery pending and reconciles only from a matching provider snapshot', async () => {
    pawa.initiateRefund.mockRejectedValueOnce(
      new PaymentGatewayUnavailableError(PaymentProvider.PAWAPAY, 'timeout', {
        retryable: false,
        uncertainDelivery: true,
      }),
    );
    expect((await service.createRefund(dto(), actor)).status).toBe(
      PawaPayRefundStatus.INITIATED,
    );
    const checked = await service.checkRefund(refundId);
    expect(checked.status).toBe(PawaPayRefundStatus.COMPLETED);
    expect(checked.completedAt).toBeInstanceOf(Date);
  });

  it('retries a missing refund after two minutes with the original UUID', async () => {
    pawa.initiateRefund.mockRejectedValueOnce(
      new PaymentGatewayUnavailableError(PaymentProvider.PAWAPAY, 'timeout', {
        retryable: false,
        uncertainDelivery: true,
      }),
    );
    await service.createRefund(dto(), actor);
    refunds.get(refundId)!.createdAt = new Date(Date.now() - 121_000);
    pawa.checkRefund.mockResolvedValueOnce({
      paymentId: refundId,
      status: 'NOT_FOUND',
      raw: { status: 'NOT_FOUND' },
    });

    const retried = await service.retryRefund(refundId);

    expect(retried.status).toBe(PawaPayRefundStatus.INITIATED);
    expect(pawa.initiateRefund).toHaveBeenCalledTimes(2);
    expect(pawa.initiateRefund.mock.calls[1][0].refundId).toBe(refundId);
  });

  it('does not retry a refund before two minutes or when pawaPay already knows it', async () => {
    await service.createRefund(dto(), actor);
    refunds.get(refundId)!.createdAt = new Date();
    await expect(service.retryRefund(refundId)).rejects.toThrow('deux minutes');
    refunds.get(refundId)!.createdAt = new Date(Date.now() - 121_000);
    pawa.checkRefund.mockResolvedValueOnce({
      paymentId: refundId,
      status: 'ENQUEUED',
      amount: '40',
      currency: 'CDF',
      clientReferenceId: payment.reference,
      raw: {
        status: 'FOUND',
        data: { refundId, status: 'ENQUEUED', depositId },
      },
    });

    expect((await service.retryRefund(refundId)).status).toBe(
      PawaPayRefundStatus.INITIATED,
    );
    expect(pawa.initiateRefund).toHaveBeenCalledTimes(1);
  });

  it('never reopens a terminal failure after a late success', async () => {
    pawa.initiateRefund.mockResolvedValueOnce({
      accepted: false,
      status: 'REJECTED',
      raw: {},
    });
    await service.createRefund(dto(), actor);
    await expect(service.checkRefund(refundId)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(refunds.get(refundId)?.status).toBe(PawaPayRefundStatus.FAILED);
  });

  it('requires a documented business reversal for a wallet top-up', async () => {
    payment.purpose = PaymentPurpose.WALLET_TOP_UP;
    await expect(service.createRefund(dto(), actor)).rejects.toThrow(
      'régularisation métier',
    );
    await service.createRefund(
      { ...dto(), businessReversalReference: 'LEDGER-123' },
      actor,
    );
    expect(pawa.initiateRefund).toHaveBeenCalledTimes(1);
  });

  it('forces a provider status check for admin reconciliation', async () => {
    await service.checkPayment(payment.id);
    expect(paymentService.checkPaymentStatus).toHaveBeenCalledWith(
      depositId,
      undefined,
      true,
    );
  });
});
