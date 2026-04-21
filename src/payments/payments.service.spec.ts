import {
  PaymentMethod,
  PaymentStatus,
} from './entities/payment-transaction.entity';
import { PaymentsService } from './payments.service';

describe('PaymentsService', () => {
  let paymentTransactionRepository: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let configService: {
    get: jest.Mock;
  };
  let flexPayService: {
    initiatePayment: jest.Mock;
    isSuccessfulCode: jest.Mock;
  };
  let service: PaymentsService;

  beforeEach(() => {
    paymentTransactionRepository = {
      create: jest.fn((payload) => payload),
      save: jest.fn(async (payload) => ({
        id: payload.id ?? 'payment-1',
        ...payload,
      })),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'FLEXPAY_CALLBACK_BASE_URL') {
          return 'https://api.zwanga.cd/api/v1';
        }

        return undefined;
      }),
    };
    flexPayService = {
      initiatePayment: jest.fn().mockResolvedValue({
        code: '0',
        message: 'Redirection en cours',
        orderNumber: 'ORD123',
        paymentUrl: 'https://beta-cardpayment.flexpay.cd/redirect/ORD123',
        raw: {},
      }),
      isSuccessfulCode: jest.fn().mockReturnValue(true),
    };

    service = new PaymentsService(
      paymentTransactionRepository as any,
      configService as any,
      flexPayService as any,
    );
  });

  it('generates a FlexPay-compatible reference with at most 25 characters', async () => {
    const payment = await service.initiatePayment({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      method: PaymentMethod.CARD,
      amount: 5000,
      currency: 'CDF',
      description: 'Abonnement Zwanga Pro',
      referencePrefix: 'SUB',
      approveUrl: 'zwanga://subscriptions/payment?status=success',
      cancelUrl: 'zwanga://subscriptions/payment?status=cancel',
      declineUrl: 'zwanga://subscriptions/payment?status=decline',
    });

    const flexPayCall = flexPayService.initiatePayment.mock.calls[0][0];

    expect(flexPayCall.reference).toMatch(/^[A-Z0-9]+$/);
    expect(flexPayCall.reference.length).toBeLessThanOrEqual(25);
    expect(flexPayCall.reference.length).toBeGreaterThanOrEqual(12);
    expect(flexPayCall.reference.startsWith('SUB')).toBe(true);
    expect(payment.reference).toBe(flexPayCall.reference);
    expect(payment.status).toBe(PaymentStatus.INITIATED);
  });
});
