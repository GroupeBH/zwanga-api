import {
  PaymentMethod,
  PaymentStatus,
} from './entities/payment-transaction.entity';
import { PaymentsService } from './payments.service';

describe('PaymentsService', () => {
  let paymentTransactionRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
  };
  let configService: {
    get: jest.Mock;
  };
  let flexPayService: {
    initiatePayment: jest.Mock;
    checkTransaction: jest.Mock;
    isSuccessfulCode: jest.Mock;
    isSuccessfulTransaction: jest.Mock;
  };
  let service: PaymentsService;

  beforeEach(() => {
    paymentTransactionRepository = {
      create: jest.fn((payload) => payload),
      save: jest.fn(async (payload) => ({
        id: payload.id ?? 'payment-1',
        ...payload,
      })),
      findOne: jest.fn(),
      find: jest.fn(),
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
      initiatePayout: jest.fn().mockResolvedValue({
        code: '0',
        message: 'Payout envoye avec succes',
        orderNumber: 'PAYOUT123',
        paymentUrl: null,
        raw: {},
      }),
      checkTransaction: jest.fn(),
      isSuccessfulCode: jest.fn().mockReturnValue(true),
      isSuccessfulTransaction: jest.fn().mockReturnValue(false),
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
    expect(payment.providerMessage).toBe(
      'Redirection vers la page de paiement en cours',
    );
  });

  it('returns the current user payment transactions from newest to oldest', async () => {
    const transactions = [
      {
        id: 'payment-2',
        userId: 'user-1',
        status: PaymentStatus.SUCCEEDED,
        createdAt: new Date('2026-05-02T10:00:00.000Z'),
      },
      {
        id: 'payment-1',
        userId: 'user-1',
        status: PaymentStatus.FAILED,
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
      },
    ];
    paymentTransactionRepository.find.mockResolvedValue(transactions);

    const result = await service.findUserTransactions('user-1');

    expect(paymentTransactionRepository.find).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { createdAt: 'DESC' },
    });
    expect(result).toBe(transactions);
  });

  it('accepts a FlexPay check response when the reference field mirrors the order number', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      status: PaymentStatus.INITIATED,
      reference: 'SUBMO8LT0SM0255ED90F8',
      orderNumber: 'r2npySEnChn6243831919710',
      providerMessage: null,
      providerStatusCode: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    flexPayService.checkTransaction.mockResolvedValue({
      code: '0',
      message: 'Une transaction trouvee',
      transaction: {
        orderNumber: 'r2npySEnChn6243831919710',
        reference: 'r2npySEnChn6243831919710',
        status: '4',
        amount: '5000',
        amountCustomer: '5000',
        currency: 'CDF',
        createdAt: '2026-04-21 13:32:55',
      },
      raw: {
        Code: '0',
      },
    });

    const payment = await service.checkPaymentStatus(
      'r2npySEnChn6243831919710',
      'user-1',
    );

    expect(payment.status).toBe(PaymentStatus.INITIATED);
    expect(payment.providerStatusCode).toBe('4');
    expect(payment.providerMessage).toBe('Paiement en attente de confirmation');
    expect(flexPayService.checkTransaction).toHaveBeenCalledWith(
      'r2npySEnChn6243831919710',
    );
  });

  it('returns a french success message after a confirmed payment check', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      status: PaymentStatus.INITIATED,
      reference: 'SUBMO8LT0SM0255ED90F8',
      orderNumber: 'r2npySEnChn6243831919710',
      providerMessage: null,
      providerStatusCode: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    flexPayService.checkTransaction.mockResolvedValue({
      code: '0',
      message: 'Une transaction trouvee',
      transaction: {
        orderNumber: 'r2npySEnChn6243831919710',
        reference: 'SUBMO8LT0SM0255ED90F8',
        status: '0',
        amount: '5000',
        amountCustomer: '5000',
        currency: 'CDF',
        createdAt: '2026-04-21 13:32:55',
      },
      raw: {
        Code: '0',
      },
    });

    flexPayService.isSuccessfulTransaction.mockReturnValue(true);

    const payment = await service.checkPaymentStatus(
      'r2npySEnChn6243831919710',
      'user-1',
    );

    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(payment.providerMessage).toBe('Paiement confirme avec succes');
    expect(payment.paidAt).toBeInstanceOf(Date);
  });

  it('still rejects a FlexPay check response for a different reference', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      status: PaymentStatus.INITIATED,
      reference: 'SUBMO8LT0SM0255ED90F8',
      orderNumber: 'r2npySEnChn6243831919710',
      providerMessage: null,
      providerStatusCode: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    flexPayService.checkTransaction.mockResolvedValue({
      code: '0',
      message: 'Une transaction trouvee',
      transaction: {
        orderNumber: 'r2npySEnChn6243831919710',
        reference: 'SOMEONEELSE123',
        status: '4',
        amount: '5000',
        amountCustomer: '5000',
        currency: 'CDF',
        createdAt: '2026-04-21 13:32:55',
      },
      raw: {
        Code: '0',
      },
    });

    await expect(
      service.checkPaymentStatus('r2npySEnChn6243831919710', 'user-1'),
    ).rejects.toThrow('La reference FlexPay ne correspond pas a cette transaction');
  });

  it('tracks a FlexPay merchant payout as a driver payout transaction', async () => {
    const payout = await service.initiatePayout({
      userId: 'driver-1',
      purpose: 'driver_payout',
      relatedEntityType: 'driver_payout',
      relatedEntityId: 'payout-1',
      phone: '+243891234567',
      amount: 9500,
      currency: 'CDF',
      description: 'Paiement chauffeur Zwanga payout-1',
      callbackUrl:
        'https://api.zwanga.cd/api/v1/driver-settlements/payouts/flexpay/callback',
      referencePrefix: 'DRV',
    });

    expect(flexPayService.initiatePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '+243891234567',
        amount: 9500,
        currency: 'CDF',
      }),
    );
    expect(payout.status).toBe(PaymentStatus.INITIATED);
    expect(payout.orderNumber).toBe('PAYOUT123');
  });
});
