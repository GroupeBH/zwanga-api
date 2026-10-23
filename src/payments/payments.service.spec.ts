/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { BadGatewayException, Logger } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from './entities/payment-transaction.entity';
import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';
import { PaymentsService } from './payments.service';
import { PaymentSettlementRegistry } from './payment-settlement.registry';
import { TOKEN_WITHDRAWAL_DISABLED } from './token-withdrawal.policy';
import { PaymentGatewayUnavailableError } from './payment-provider.policy';

describe('PaymentsService', () => {
  let paymentTransactionRepository: {
    manager: any;
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
    initiatePayout: jest.Mock;
    checkTransaction: jest.Mock;
    checkPayoutTransaction: jest.Mock;
    isSuccessfulCode: jest.Mock;
    isSuccessfulTransaction: jest.Mock;
  };
  let service: PaymentsService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let stored: any;
    let draft: any;
    const manager = {
      transaction: async (work: any) => work(manager),
      findOne: async (entity: unknown, options: any) => {
        if (entity === PaymentTransaction) {
          const payment = stored ?? await paymentTransactionRepository.findOne(options);
          return payment ? { provider: PaymentProvider.FLEXPAY, ...payment } : null;
        }
        if (entity === DriverPayout) return { id: draft.relatedEntityId, driverId: draft.userId,
          amount: draft.amount, currency: draft.currency, status: 'pending' };
        if (entity === ReferralWithdrawal) return { id: draft.relatedEntityId, userId: draft.userId,
          amount: draft.amount, currency: draft.currency, phone: draft.phone, status: 'pending' };
        return { id: draft?.userId };
      },
      save: async (entity: unknown, value: any) => entity === PaymentTransaction ? paymentTransactionRepository.save(value) : value,
    };
    paymentTransactionRepository = {
      manager,
      create: jest.fn((payload) => { draft = payload; return payload; }),
      save: jest.fn(async (payload) => { stored = {
        id: payload.id ?? 'payment-1',
        ...payload,
      }; return { ...stored }; }),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'FLEXPAY_CALLBACK_BASE_URL') {
          return 'https://api.zwanga.cd/api/v1';
        }
        if (key === 'FLEXPAY_VERIFY_CALLBACKS') {
          return 'false';
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
      checkPayoutTransaction: jest.fn(),
      isSuccessfulCode: jest.fn().mockReturnValue(true),
      isSuccessfulTransaction: jest.fn().mockReturnValue(false),
    };

    service = new PaymentsService(
      paymentTransactionRepository as any,
      configService as any,
      flexPayService as any,
      { isConfigured: () => false } as any,
      new PaymentSettlementRegistry(),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [PaymentPurpose.WALLET_PAYOUT, PaymentProvider.FLEXPAY],
    [PaymentPurpose.WALLET_PAYOUT, PaymentProvider.PAWAPAY],
    [PaymentPurpose.REFERRAL_PAYOUT, PaymentProvider.FLEXPAY],
    [PaymentPurpose.REFERRAL_PAYOUT, PaymentProvider.PAWAPAY],
  ])('rejects wallet or unbound referral payouts (%s through %s) before persistence', async (purpose, preferredProvider) => {
    const pawaPay = { isConfigured: jest.fn().mockReturnValue(true), initiatePayout: jest.fn() };
    const guardedService = new PaymentsService(
      paymentTransactionRepository as any,
      configService as any,
      flexPayService as any,
      pawaPay as any,
      new PaymentSettlementRegistry(),
    );
    await expect(guardedService.initiatePayout({
      userId: 'user-1', purpose, preferredProvider,
      phone: '+243891234567', amount: 5000, currency: 'CDF',
      description: 'Token withdrawal',
    })).rejects.toMatchObject({ status: 403, response: TOKEN_WITHDRAWAL_DISABLED });
    expect(paymentTransactionRepository.create).not.toHaveBeenCalled();
    expect(paymentTransactionRepository.save).not.toHaveBeenCalled();
    expect(flexPayService.initiatePayout).not.toHaveBeenCalled();
    expect(pawaPay.initiatePayout).not.toHaveBeenCalled();
    expect(pawaPay.isConfigured).not.toHaveBeenCalled();
  });

  it('allows an explicitly bound referral withdrawal of 1000 tokens at 10 CDF', async () => {
    const input = { userId: 'referrer', purpose: PaymentPurpose.REFERRAL_PAYOUT,
      relatedEntityType: 'referral_withdrawal', relatedEntityId: 'withdrawal-1',
      phone: '+243891234567', amount: 10000, currency: 'CDF', description: 'Retrait de parrainage' };
    await expect(service.initiatePayout(input)).resolves.toMatchObject({ purpose: PaymentPurpose.REFERRAL_PAYOUT, amount: 10000 });
    expect(flexPayService.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it.each(['accepted', 'refused', 'timeout'])(
    'returns a concurrently confirmed deposit despite a late %s initiation result', async result => {
      const paidAt = new Date();
      flexPayService.isSuccessfulCode.mockReturnValue(result !== 'refused');
      flexPayService.initiatePayment.mockImplementation(async () => {
        const draft = paymentTransactionRepository.create.mock.results[0].value;
        await paymentTransactionRepository.save({
          ...draft, id: 'payment-1', status: PaymentStatus.SUCCEEDED,
          orderNumber: 'ORD123', paidAt,
        });
        if (result === 'timeout') throw new PaymentGatewayUnavailableError(
          PaymentProvider.FLEXPAY, 'synthetic timeout', { uncertainDelivery: true },
        );
        return { code: result === 'refused' ? '1' : '0', orderNumber: 'ORD123',
          message: result === 'refused' ? 'invalid token' : 'accepted', raw: {} };
      });
      const saved = await service.initiatePayment({
        userId: 'user-1', method: PaymentMethod.MOBILE_MONEY,
        phone: '+243891234567', amount: 5000, currency: 'CDF', description: 'Synthetic',
      });
      expect(saved).toMatchObject({ status: PaymentStatus.SUCCEEDED, paidAt });
      expect(flexPayService.initiatePayment).toHaveBeenCalledTimes(1);
    },
  );

  it('a topup retry verifies the original payment without sending a new debit', async () => {
    const input = { userId: 'user', purpose: 'wallet_top_up', idempotencyKey: 'stable-key',
      method: PaymentMethod.CARD, amount: 5000, currency: 'CDF', description: 'Synthetic topup' };
    const first = await service.initiatePayment(input);
    paymentTransactionRepository.save.mockRejectedValueOnce({ code: '23505' });
    paymentTransactionRepository.findOne.mockResolvedValue(first);
    const check = jest.spyOn(service, 'checkPaymentStatus').mockResolvedValue(first);
    expect(await service.initiatePayment(input)).toBe(first);
    expect(check).toHaveBeenCalledWith(first.orderNumber, input.userId);
    expect(flexPayService.initiatePayment).toHaveBeenCalledTimes(1);
    expect(first.reference).toMatch(/^[A-Z0-9]{25}$/);
  });

  it('reads a pending topup by its internal reference with the account guard and no new debit', async () => {
    const transaction = { id: 'pending', userId: 'user', purpose: 'wallet_top_up',
      reference: 'WALPENDING', status: PaymentStatus.PENDING, orderNumber: null, providerReference: null };
    paymentTransactionRepository.findOne.mockResolvedValue(transaction);
    expect(await service.checkPaymentStatus('WALPENDING', 'user')).toBe(transaction);
    expect(paymentTransactionRepository.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: [{ orderNumber: 'WALPENDING', userId: 'user' }, { reference: 'WALPENDING', purpose: 'wallet_top_up', userId: 'user' }],
    }));
    expect(flexPayService.initiatePayment).not.toHaveBeenCalled();
    expect(flexPayService.checkTransaction).not.toHaveBeenCalled();
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

  it('verifies cash-redeemable topups even when optional callback verification is disabled', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'topup',
      purpose: 'wallet_top_up',
      reference: 'WAL123',
      orderNumber: 'ORDER',
      status: PaymentStatus.INITIATED,
      amount: 5000,
      currency: 'CDF',
    });
    flexPayService.checkTransaction.mockResolvedValue({
      code: '0',
      transaction: {
        reference: 'WAL123',
        orderNumber: 'ORDER',
        amount: '5000',
        currency: 'CDF',
        status: '0',
      },
      raw: {},
    });
    flexPayService.isSuccessfulTransaction.mockReturnValue(true);
    const result = await service.handleFlexPayCallback({
      code: '0',
      reference: 'WAL123',
      orderNumber: 'ORDER',
    });
    expect(flexPayService.checkTransaction).toHaveBeenCalledWith('ORDER');
    expect(result.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it.each([{ orderNumber: 'OTHER' }, { reference: 'OTHER' }])(
    'rejects a forged topup identifier %p before provider verification',
    async (patch) => {
      paymentTransactionRepository.findOne.mockResolvedValue({
        id: 'topup',
        purpose: 'wallet_top_up',
        reference: 'WAL123',
        orderNumber: 'ORDER',
        status: PaymentStatus.INITIATED,
      });
      await expect(
        service.handleFlexPayCallback({
          code: '0',
          reference: 'WAL123',
          orderNumber: 'ORDER',
          ...patch,
        }),
      ).rejects.toThrow('correspond pas');
      expect(flexPayService.checkTransaction).not.toHaveBeenCalled();
    },
  );

  it('does not credit a topup from incomplete provider proof', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'topup',
      purpose: 'wallet_top_up',
      reference: 'WAL123',
      orderNumber: 'ORDER',
      status: PaymentStatus.INITIATED,
      amount: 5000,
      currency: 'CDF',
    });
    flexPayService.checkTransaction.mockResolvedValue({
      code: '0',
      transaction: {
        reference: 'WAL123',
        orderNumber: 'ORDER',
        amount: null,
        currency: null,
        status: '0',
      },
      raw: {},
    });
    flexPayService.isSuccessfulTransaction.mockReturnValue(true);
    const result = await service.handleFlexPayCallback({
      code: '0',
      reference: 'WAL123',
      orderNumber: 'ORDER',
    });
    expect(result.status).toBe(PaymentStatus.INITIATED);
  });

  it('rechecks an old succeeded topup lacking verification instead of trusting its terminal status', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'topup',
      userId: 'user',
      purpose: 'wallet_top_up',
      relatedEntityType: 'wallet_top_up',
      relatedEntityId: 'user',
      reference: 'WAL123',
      orderNumber: 'ORDER',
      status: PaymentStatus.SUCCEEDED,
      amount: 5000,
      currency: 'CDF',
      rawCheckResponse: null,
    });
    const proof = {
      code: '0',
      transaction: {
        reference: 'WAL123',
        orderNumber: 'ORDER',
        amount: '5000',
        currency: 'CDF',
        status: '0',
      },
    };
    flexPayService.checkTransaction.mockResolvedValue({ ...proof, raw: proof });
    flexPayService.isSuccessfulTransaction.mockReturnValue(true);
    const result = await service.checkPaymentStatus('ORDER', 'user');
    expect(flexPayService.checkTransaction).toHaveBeenCalledWith('ORDER');
    expect(result.rawCheckResponse).toEqual(proof);
  });

  it.each(['wallet_payout', 'driver_payout', 'referral_payout'])(
    'uses mandatory payout verification for %s callbacks',
    async (purpose) => {
      paymentTransactionRepository.findOne.mockResolvedValue({
        id: 'payout',
        purpose,
        reference: 'PAY123',
        orderNumber: 'ORDER',
        status: PaymentStatus.INITIATED,
        amount: 5000,
        currency: 'CDF',
      });
      flexPayService.checkPayoutTransaction.mockResolvedValue({
        code: '0',
        transaction: {
          reference: 'PAY123',
          orderNumber: 'ORDER',
          amount: null,
          currency: null,
          status: '0',
        },
        raw: {},
      });
      const result = await service.handleFlexPayCallback({
        code: '0',
        reference: 'PAY123',
        orderNumber: 'ORDER',
      });
      expect(flexPayService.checkPayoutTransaction).toHaveBeenCalledWith(
        'ORDER',
      );
      expect(flexPayService.checkTransaction).not.toHaveBeenCalled();
      expect(result.status).toBe(PaymentStatus.SUCCEEDED);
    },
  );

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

  it('marks an operator-declined FlexPay check as failed even when provider status is 4', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      status: PaymentStatus.INITIATED,
      reference: 'SUBMRJ532487C079775B0',
      orderNumber: 'cbj5FN6idRLx243831919710',
      providerMessage: null,
      providerStatusCode: null,
      rawCheckResponse: null,
      paidAt: null,
    });

    flexPayService.checkTransaction.mockResolvedValue({
      code: '0',
      message:
        'Transaction with code cbj5FN6idRLx243831919710 was declined by the operator',
      transaction: {
        orderNumber: 'cbj5FN6idRLx243831919710',
        reference: 'SUBMRJ532487C079775B0',
        status: '4',
        amount: '5000',
        amountCustomer: '5000',
        currency: 'CDF',
        createdAt: '2026-07-13 12:31:08',
      },
      raw: {
        Code: '0',
      },
    });

    const payment = await service.checkPaymentStatus(
      'cbj5FN6idRLx243831919710',
      'user-1',
    );

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.providerStatusCode).toBe('4');
    expect(payment.providerMessage).toBe(
      'Paiement refusé par l’opérateur. Aucun montant confirmé.',
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
    expect(payment.providerMessage).toBe('Paiement confirmé avec succès');
    expect(payment.paidAt).toBeInstanceOf(Date);
  });

  it('confirms a successful callback locally when verification is explicitly disabled', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      status: PaymentStatus.INITIATED,
      reference: 'SUBMO8LT0SM0255ED90F8',
      orderNumber: 'r2npySEnChn6243831919710',
      providerReference: null,
      providerStatusCode: null,
      providerMessage: null,
      rawCallbackPayload: null,
      paidAt: null,
    });

    const payment = await service.handleFlexPayCallback({
      code: '0',
      reference: 'SUBMO8LT0SM0255ED90F8',
      provider_reference: '7KI81020PHS',
      orderNumber: 'r2npySEnChn6243831919710',
    });

    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    expect(payment.providerMessage).toBe('Paiement confirmé avec succès');
    expect(payment.providerReference).toBe('7KI81020PHS');
    expect(payment.paidAt).toBeInstanceOf(Date);
    expect(flexPayService.checkTransaction).not.toHaveBeenCalled();
  });

  it('marks a cancelled FlexPay callback without keeping the payment pending', async () => {
    flexPayService.isSuccessfulCode.mockImplementation((code) => code === '0');
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      status: PaymentStatus.INITIATED,
      reference: 'SUBMO8LT0SM0255ED90F8',
      orderNumber: 'r2npySEnChn6243831919710',
      providerReference: null,
      providerStatusCode: null,
      providerMessage: null,
      rawCallbackPayload: null,
      paidAt: null,
    });

    const payment = await service.handleFlexPayCallback({
      code: '1',
      message: 'Operation annulee par le client',
      reference: 'SUBMO8LT0SM0255ED90F8',
      orderNumber: 'r2npySEnChn6243831919710',
    });

    expect(payment.status).toBe(PaymentStatus.CANCELLED);
    expect(payment.providerMessage).toBe(
      'Paiement annulé. Aucun montant confirmé.',
    );
  });

  it('verifies a failed callback with FlexPay by default before releasing money', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'FLEXPAY_CALLBACK_BASE_URL') {
        return 'https://api.zwanga.cd/api/v1';
      }
      return undefined;
    });
    flexPayService.isSuccessfulCode.mockImplementation((code) => code === '0');
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'driver-1',
      status: PaymentStatus.INITIATED,
      reference: 'DRV123',
      orderNumber: 'PAYOUT123',
      providerReference: null,
      providerStatusCode: null,
      providerMessage: null,
      amount: 9500,
      currency: 'CDF',
      rawCallbackPayload: null,
      rawCheckResponse: null,
      paidAt: null,
    });
    flexPayService.checkTransaction.mockResolvedValue({
      code: '0',
      message: 'Operation annulee par le client',
      transaction: {
        orderNumber: 'PAYOUT123',
        reference: 'DRV123',
        status: '1',
        amount: '9500',
        amountCustomer: '9500',
        currency: 'CDF',
        createdAt: '2026-08-26 10:00:00',
      },
      raw: { Code: '0' },
    });

    const payment = await service.handleFlexPayCallback({
      code: '1',
      message: 'Operation annulee par le client',
      reference: 'DRV123',
      orderNumber: 'PAYOUT123',
    });

    expect(flexPayService.checkTransaction).toHaveBeenCalledWith('PAYOUT123');
    expect(payment.status).toBe(PaymentStatus.CANCELLED);
  });

  it('returns terminal payment status locally without calling FlexPay again', async () => {
    paymentTransactionRepository.findOne.mockResolvedValue({
      id: 'payment-1',
      userId: 'user-1',
      status: PaymentStatus.FAILED,
      reference: 'SUBMO8LT0SM0255ED90F8',
      orderNumber: 'r2npySEnChn6243831919710',
      providerMessage: 'Paiement echoue: solde insuffisant.',
      providerStatusCode: '1',
      rawCheckResponse: null,
      paidAt: null,
    });

    const payment = await service.checkPaymentStatus(
      'r2npySEnChn6243831919710',
      'user-1',
    );

    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.providerMessage).toBe('Paiement echoue: solde insuffisant.');
    expect(flexPayService.checkTransaction).not.toHaveBeenCalled();
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
    ).rejects.toThrow(
      'La référence FlexPay ne correspond pas à cette transaction',
    );
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

  it('keeps a payout pending when FlexPay delivery is uncertain', async () => {
    flexPayService.initiatePayout.mockRejectedValue(
      new BadGatewayException('Paiement chauffeur FlexPay indisponible'),
    );

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

    expect(payout.status).toBe(PaymentStatus.PENDING);
    expect(payout.providerMessage).toContain(
      'Aucun paiement ne vous est demandé',
    );
  });

  it('does not fail over after an ambiguous FlexPay deposit error', async () => {
    flexPayService.initiatePayment.mockRejectedValue(
      new BadGatewayException('Initialisation paiement Mobile Money FlexPay indisponible'),
    );
    const pawaPay = {
      isConfigured: jest.fn().mockReturnValue(true),
      initiateDeposit: jest.fn().mockResolvedValue({
        paymentId: '11111111-1111-4111-8111-111111111111',
        status: 'ACCEPTED',
        accepted: true,
        paymentUrl: null,
        failureCode: null,
        failureMessage: null,
        raw: { status: 'ACCEPTED' },
      }),
    };
    const routed = new PaymentsService(
      paymentTransactionRepository as any,
      configService as any,
      flexPayService as any,
      pawaPay as any,
      new PaymentSettlementRegistry(),
    );

    const payment = await routed.initiatePayment({
      userId: '123e4567-e89b-12d3-a456-426614174000',
      method: PaymentMethod.MOBILE_MONEY,
      phone: '+243811234567',
      amount: 1500,
      currency: 'CDF',
      description: 'Course Zwanga',
      referencePrefix: 'TRIP',
    });

    expect(flexPayService.initiatePayment).toHaveBeenCalled();
    expect(pawaPay.initiateDeposit).not.toHaveBeenCalled();
    expect(payment.provider).toBe(PaymentProvider.FLEXPAY);
    expect(payment.status).toBe(PaymentStatus.PENDING);
  });
});
