import { BadRequestException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import { WalletAccountType } from './entities/wallet-account.entity';
import { WalletLedgerEntryType } from './entities/wallet-ledger-entry.entity';
import { WalletService } from './wallet.service';

describe('WalletService', () => {
  let accountRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let ledgerRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let manager: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let configService: { get: jest.Mock };
  let paymentsService: {
    initiatePayment: jest.Mock;
    handleFlexPayCallback: jest.Mock;
    checkPaymentStatus: jest.Mock;
    getClientPaymentMessage: jest.Mock;
    formatLogPayload: jest.Mock;
  };
  let service: WalletService;

  const account = {
    id: 'wallet-1',
    userId: 'passenger-1',
    type: WalletAccountType.POINTS,
    balance: 1000,
    currency: 'CDF',
  };

  const topUpPayment = {
    id: 'payment-1',
    userId: 'passenger-1',
    purpose: PaymentPurpose.WALLET_TOP_UP,
    relatedEntityType: 'wallet_top_up',
    relatedEntityId: 'passenger-1',
    method: PaymentMethod.MOBILE_MONEY,
    status: PaymentStatus.INITIATED,
    reference: 'WALLET123',
    orderNumber: 'ORDER123',
    providerStatusCode: '0',
    providerMessage: 'Demande envoyee',
    paymentUrl: null,
    amount: 5000,
    currency: 'CDF',
  };

  beforeEach(() => {
    accountRepository = {
      findOne: jest.fn().mockResolvedValue({ ...account }),
      create: jest.fn((payload: unknown) => payload),
      save: jest.fn((payload: unknown) => Promise.resolve(payload)),
    };
    ledgerRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    manager = {
      findOne: jest.fn().mockResolvedValue({ ...account }),
      create: jest.fn((_entity: unknown, payload: unknown) => payload),
      save: jest.fn((payload: unknown) => Promise.resolve(payload)),
    };
    dataSource = {
      transaction: jest.fn(
        (callback: (entityManager: typeof manager) => unknown) =>
          callback(manager),
      ),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'ZWANGA_POINTS_CURRENCY') {
          return 'CDF';
        }
        if (key === 'FLEXPAY_CALLBACK_BASE_URL') {
          return 'https://api.zwanga.cd/api/v1';
        }
        return undefined;
      }),
    };
    paymentsService = {
      initiatePayment: jest.fn(),
      handleFlexPayCallback: jest.fn(),
      checkPaymentStatus: jest.fn(),
      getClientPaymentMessage: jest.fn().mockReturnValue('Paiement initialise'),
      formatLogPayload: jest.fn((payload: unknown) => JSON.stringify(payload)),
    };

    service = new WalletService(
      accountRepository as any,
      ledgerRepository as any,
      dataSource as any,
      configService as any,
      paymentsService as any,
    );
  });

  it('initiates a FlexPay purchase where one CDF buys one point', async () => {
    paymentsService.initiatePayment.mockResolvedValue(topUpPayment);

    const result = await service.initiateTopUp('passenger-1', {
      amount: 5000,
      method: PaymentMethod.MOBILE_MONEY,
      phone: '243891234567',
    });

    expect(paymentsService.initiatePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'passenger-1',
        purpose: PaymentPurpose.WALLET_TOP_UP,
        relatedEntityType: 'wallet_top_up',
        relatedEntityId: 'passenger-1',
        amount: 5000,
        currency: 'CDF',
        callbackUrl:
          'https://api.zwanga.cd/api/v1/wallet/topups/flexpay/callback',
      }),
    );
    expect(result.account.balance).toBe(1000);
    expect(result.payment.orderNumber).toBe('ORDER123');
  });

  it('credits points only after FlexPay confirms the purchase', async () => {
    const succeededPayment = {
      ...topUpPayment,
      status: PaymentStatus.SUCCEEDED,
      paidAt: new Date(),
    };
    paymentsService.handleFlexPayCallback.mockResolvedValue(succeededPayment);
    accountRepository.findOne.mockResolvedValue({
      ...account,
      balance: 6000,
    });

    const result = await service.handleTopUpCallback({
      code: '0',
      reference: 'WALLET123',
      orderNumber: 'ORDER123',
    });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ balance: 6000 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.TOP_UP,
        amount: 5000,
        balanceAfter: 6000,
        paymentTransactionId: 'payment-1',
      }),
    );
    expect(result.account.balance).toBe(6000);
  });

  it('does not credit the same successful top-up twice', async () => {
    paymentsService.checkPaymentStatus.mockResolvedValue({
      ...topUpPayment,
      status: PaymentStatus.SUCCEEDED,
    });
    ledgerRepository.findOne.mockResolvedValue({
      id: 'entry-1',
      type: WalletLedgerEntryType.TOP_UP,
      paymentTransactionId: 'payment-1',
    });

    await service.checkTopUpPaymentStatus('passenger-1', 'ORDER123');

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a trip payment when the points balance is insufficient', async () => {
    manager.findOne.mockResolvedValue({ ...account, balance: 1000 });

    await expect(
      service.payForBooking(
        {
          id: 'booking-1',
          passengerId: 'passenger-1',
        } as any,
        2500,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(manager.save).not.toHaveBeenCalled();
  });

  it('refunds a points trip payment once', async () => {
    ledgerRepository.findOne
      .mockResolvedValueOnce({
        id: 'entry-payment',
        amount: -2500,
        type: WalletLedgerEntryType.BOOKING_PAYMENT,
      })
      .mockResolvedValueOnce(null);
    manager.findOne.mockResolvedValue({ ...account, balance: 1000 });

    const refunded = await service.refundBookingPayment({
      id: 'booking-1',
      passengerId: 'passenger-1',
    } as any);

    expect(refunded).toBe(true);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ balance: 3500 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.BOOKING_REFUND,
        amount: 2500,
        balanceAfter: 3500,
      }),
    );
  });

  it('credits an interrupted-trip fare difference as reusable points', async () => {
    manager.findOne.mockResolvedValue({ ...account, balance: 1000 });

    await service.creditBookingFareAdjustment(
      {
        id: 'booking-1',
        passengerId: 'passenger-1',
        paymentTransactionId: 'payment-1',
      } as any,
      1500,
    );

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ balance: 2500 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
        amount: 1500,
        balanceAfter: 2500,
        relatedEntityType: 'booking',
        relatedEntityId: 'booking-1',
        paymentTransactionId: 'payment-1',
      }),
    );
  });

  it('does not credit the same interrupted-trip fare adjustment twice', async () => {
    const existingAdjustment = {
      id: 'entry-adjustment',
      type: WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
      amount: 1500,
    };
    ledgerRepository.findOne.mockResolvedValue(existingAdjustment);

    const result = await service.creditBookingFareAdjustment(
      {
        id: 'booking-1',
        passengerId: 'passenger-1',
        paymentTransactionId: 'payment-1',
      } as any,
      1500,
    );

    expect(result).toBe(existingAdjustment);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
