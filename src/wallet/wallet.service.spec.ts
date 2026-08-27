import { BadRequestException } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import {
  WalletAccount,
  WalletAccountType,
} from './entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from './entities/wallet-ledger-entry.entity';
import { WalletService } from './wallet.service';
import { UserRole } from '../users/entities/user.entity';

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
  let userRepository: {
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
    currency: 'PTS',
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
    userRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'recipient-1',
        firstName: 'Jane',
        lastName: 'Kanda',
        phone: '+243899999999',
        email: 'jane@zwanga.cd',
        isActive: true,
      }),
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
          return 'PTS';
        }
        if (key === 'ZWANGA_POINT_VALUE_CDF') {
          return 100;
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
      userRepository as any,
      dataSource as any,
      configService as any,
      paymentsService as any,
    );
  });

  it('initiates a FlexPay purchase where one point costs 100 CDF', async () => {
    paymentsService.initiatePayment.mockResolvedValue(topUpPayment);

    const result = await service.initiateTopUp('passenger-1', {
      amount: 50,
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
        description: 'Achat de 50 jetons Zwanga',
        callbackUrl:
          'https://api.zwanga.cd/api/v1/wallet/topups/flexpay/callback',
      }),
    );
    expect(result.account.balance).toBe(1000);
    expect(result.payment.orderNumber).toBe('ORDER123');
  });

  it('applies an admin adjustment and its ledger entry atomically', async () => {
    userRepository.findOne.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'admin-1'
            ? { id: 'admin-1', role: UserRole.ADMIN }
            : { id: 'passenger-1', role: UserRole.PASSENGER },
        ),
    );
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === WalletAccount) {
        return Promise.resolve({ ...account });
      }
      return Promise.resolve(null);
    });

    const result = await service.applyAdminAdjustment(
      'admin-1',
      'passenger-1',
      25,
      'Regularisation ticket SUP-1042',
      '123e4567-e89b-12d3-a456-426614174000',
    );

    expect(result.balance).toBe(1025);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wallet-1', balance: 1025 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.ADMIN_ADJUSTMENT,
        amount: 25,
        balanceAfter: 1025,
        relatedEntityType: 'admin_wallet_adjustment',
        relatedEntityId: '123e4567-e89b-12d3-a456-426614174000',
        description:
          'Ajustement par admin admin-1: Regularisation ticket SUP-1042',
      }),
    );
  });

  it('does not apply the same admin adjustment request twice', async () => {
    userRepository.findOne.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'admin-1'
            ? { id: 'admin-1', role: UserRole.ADMIN }
            : { id: 'passenger-1', role: UserRole.PASSENGER },
        ),
    );
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === WalletAccount) {
        return Promise.resolve({ ...account, balance: 1025 });
      }
      if (entity === WalletLedgerEntry) {
        return Promise.resolve({
          id: 'adjustment-1',
          userId: 'passenger-1',
          type: WalletLedgerEntryType.ADMIN_ADJUSTMENT,
        });
      }
      return Promise.resolve(null);
    });

    const result = await service.applyAdminAdjustment(
      'admin-1',
      'passenger-1',
      25,
      'Regularisation ticket SUP-1042',
      '123e4567-e89b-12d3-a456-426614174000',
    );

    expect(result.balance).toBe(1025);
    expect(manager.save).not.toHaveBeenCalled();
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
      balance: 1050,
    });

    const result = await service.handleTopUpCallback({
      code: '0',
      reference: 'WALLET123',
      orderNumber: 'ORDER123',
    });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ balance: 1050 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.TOP_UP,
        amount: 50,
        balanceAfter: 1050,
        paymentTransactionId: 'payment-1',
      }),
    );
    expect(result.account.balance).toBe(1050);
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
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === WalletAccount) {
        return Promise.resolve({ ...account, balance: 10 });
      }
      if (entity === WalletLedgerEntry) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

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

  it('writes the token debit and its immutable ledger entry in one transaction', async () => {
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === WalletAccount) {
        return Promise.resolve({ ...account, balance: 100 });
      }
      if (entity === WalletLedgerEntry) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const entry = await service.payForBooking(
      {
        id: 'booking-atomic',
        passengerId: 'passenger-1',
        paymentCurrency: 'CDF',
      } as any,
      2500,
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wallet-1', balance: 75 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.BOOKING_PAYMENT,
        amount: -25,
        balanceAfter: 75,
        relatedEntityId: 'booking-atomic',
      }),
    );
    expect(entry).toEqual(
      expect.objectContaining({
        type: WalletLedgerEntryType.BOOKING_PAYMENT,
        amount: -25,
      }),
    );
  });

  it('does not debit a booking twice when the request is retried', async () => {
    const existingDebit = {
      id: 'entry-existing',
      amount: -25,
      type: WalletLedgerEntryType.BOOKING_PAYMENT,
      relatedEntityType: 'booking',
      relatedEntityId: 'booking-retry',
    };
    let ledgerLookup = 0;
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === WalletAccount) {
        return Promise.resolve({ ...account, balance: 75 });
      }
      if (entity === WalletLedgerEntry) {
        ledgerLookup += 1;
        return Promise.resolve(ledgerLookup === 1 ? null : existingDebit);
      }
      return Promise.resolve(null);
    });

    const entry = await service.payForBooking(
      {
        id: 'booking-retry',
        passengerId: 'passenger-1',
        paymentCurrency: 'CDF',
      } as any,
      2500,
    );

    expect(entry).toBe(existingDebit);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('never captures a booking again after an immutable refund', async () => {
    manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === WalletAccount) {
        return Promise.resolve({ ...account, balance: 100 });
      }
      if (entity === WalletLedgerEntry) {
        return Promise.resolve({
          id: 'refund-existing',
          type: WalletLedgerEntryType.BOOKING_REFUND,
          amount: 25,
        });
      }
      return Promise.resolve(null);
    });

    await expect(
      service.payForBooking(
        {
          id: 'booking-refunded',
          passengerId: 'passenger-1',
          paymentCurrency: 'CDF',
        } as any,
        2500,
      ),
    ).rejects.toThrow('deja ete remboursee');

    expect(manager.save).not.toHaveBeenCalled();
  });

  it('refunds a points trip payment once', async () => {
    ledgerRepository.findOne
      .mockResolvedValueOnce({
        id: 'entry-payment',
        amount: -25,
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
      expect.objectContaining({ balance: 1025 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.BOOKING_REFUND,
        amount: 25,
        balanceAfter: 1025,
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
      expect.objectContaining({ balance: 1015 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.BOOKING_FARE_ADJUSTMENT,
        amount: 15,
        balanceAfter: 1015,
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
      amount: 15,
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

  it('pays a subscription with points once', async () => {
    manager.findOne.mockResolvedValue({ ...account, balance: 60 });

    const entry = await service.payForSubscription(
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        userId: 'passenger-1',
      },
      50,
    );

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ balance: 10 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.SUBSCRIPTION_PAYMENT,
        amount: -50,
        balanceAfter: 10,
        relatedEntityType: 'subscription',
        relatedEntityId: '123e4567-e89b-12d3-a456-426614174000',
      }),
    );
    expect(entry).toEqual(
      expect.objectContaining({
        type: WalletLedgerEntryType.SUBSCRIPTION_PAYMENT,
      }),
    );
  });

  it('transfers points to another platform user atomically', async () => {
    manager.findOne
      .mockResolvedValueOnce({
        ...account,
        userId: 'passenger-1',
        balance: 6000,
      })
      .mockResolvedValueOnce({
        ...account,
        id: 'wallet-2',
        userId: 'recipient-1',
        balance: 1000,
      });

    const result = await service.transferPoints('passenger-1', {
      amount: 2500,
      recipientPhone: '+243899999999',
      note: 'Pour ton trajet',
    });

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: [{ phone: '+243899999999' }],
    });
    expect(result.amount).toBe(2500);
    expect(result.recipient.id).toBe('recipient-1');
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'passenger-1',
        balance: 3500,
      }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'recipient-1',
        balance: 3500,
      }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.TRANSFER_OUT,
        amount: -2500,
        relatedEntityType: 'wallet_transfer',
      }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.TRANSFER_IN,
        amount: 2500,
        relatedEntityType: 'wallet_transfer',
      }),
    );
  });

  it('awards the base loyalty point even when the completed trip is free', async () => {
    manager.findOne.mockResolvedValue({ ...account, balance: 1000 });

    await service.awardLoyaltyForBooking(
      {
        id: 'booking-1',
        passengerId: 'passenger-1',
        paymentCurrency: 'CDF',
      } as any,
      0,
    );

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.LOYALTY_REWARD,
        amount: 1,
        balanceAfter: 1001,
      }),
    );
  });

  it('credits exactly 25 tokens for a paid subscription', async () => {
    manager.findOne.mockResolvedValue({ ...account, balance: 1000 });

    const entry = await service.awardSubscriptionPaymentTokens(
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        userId: 'passenger-1',
      },
      'payment-1',
    );

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ balance: 1025 }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.SUBSCRIPTION_REWARD,
        amount: 25,
        balanceAfter: 1025,
        relatedEntityType: 'subscription',
        relatedEntityId: '123e4567-e89b-12d3-a456-426614174000',
        paymentTransactionId: 'payment-1',
        description:
          'Bonus de 25 jetons pour l abonnement 123e4567-e89b-12d3-a456-426614174000',
      }),
    );
    expect(entry).toEqual(
      expect.objectContaining({
        type: WalletLedgerEntryType.SUBSCRIPTION_REWARD,
        amount: 25,
      }),
    );
  });

  it('does not credit the subscription reward twice', async () => {
    const existingReward = {
      id: 'reward-entry-1',
      type: WalletLedgerEntryType.SUBSCRIPTION_REWARD,
      amount: 25,
    };
    ledgerRepository.findOne.mockResolvedValue(existingReward);

    const result = await service.awardSubscriptionPaymentTokens({
      id: '123e4567-e89b-12d3-a456-426614174000',
      userId: 'passenger-1',
    });

    expect(result).toBe(existingReward);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('adds 0.5 point per travelled kilometer on top of the base point', async () => {
    manager.findOne.mockResolvedValue({ ...account, balance: 1000 });

    await service.awardLoyaltyForBooking(
      {
        id: 'booking-1',
        passengerId: 'passenger-1',
        travelledDistanceMeters: 4500,
        paymentCurrency: 'CDF',
      } as any,
      10000,
    );

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.LOYALTY_REWARD,
        amount: 3.25,
        balanceAfter: 1003.25,
      }),
    );
  });

  it('converts the price-based loyalty bonus from CDF to points', async () => {
    manager.findOne.mockResolvedValue({ ...account, balance: 1000 });

    await service.awardLoyaltyForBooking(
      {
        id: 'booking-1',
        passengerId: 'passenger-1',
        paymentCurrency: 'CDF',
      } as any,
      5000,
    );

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletLedgerEntryType.LOYALTY_REWARD,
        amount: 1.5,
        balanceAfter: 1001.5,
      }),
    );
  });
});
