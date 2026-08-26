import {
  BookingPaymentStatus,
  BookingStatus,
} from '../bookings/entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { User } from '../users/entities/user.entity';
import { DriverSettlementsService } from './driver-settlements.service';
import { DriverEarningStatus } from './entities/driver-earning.entity';
import {
  DriverPayout,
  DriverPayoutStatus,
} from './entities/driver-payout.entity';

describe('DriverSettlementsService', () => {
  let earningRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let payoutRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let configService: { get: jest.Mock };
  let kycRepository: { exists: jest.Mock };
  let bookingRepository: { find: jest.Mock };
  let tripRepository: { findOne: jest.Mock };
  let userRepository: { findOne: jest.Mock };
  let notificationService: { sendNotification: jest.Mock };
  let paymentsService: {
    initiatePayout: jest.Mock;
    findLatestTransactionForRelatedEntity: jest.Mock;
    getClientPaymentMessage: jest.Mock;
    formatLogPayload: jest.Mock;
    formatPaymentLogResponse: jest.Mock;
  };
  let manager: {
    findOne: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let service: DriverSettlementsService;

  beforeEach(() => {
    earningRepository = {
      findOne: jest.fn(),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (payload) => ({ id: 'earning-1', ...payload })),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    payoutRepository = {
      findOne: jest.fn(),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (payload) => ({ id: 'payout-1', ...payload })),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'ZWANGA_COMMISSION_RATE') {
          return '0.05';
        }
        if (key === 'TRIP_PAYMENT_CURRENCY') {
          return 'CDF';
        }
        return undefined;
      }),
    };
    kycRepository = { exists: jest.fn().mockResolvedValue(true) };
    bookingRepository = { find: jest.fn().mockResolvedValue([]) };
    tripRepository = { findOne: jest.fn() };
    userRepository = { findOne: jest.fn() };
    notificationService = { sendNotification: jest.fn().mockResolvedValue(true) };
    paymentsService = {
      initiatePayout: jest.fn(),
      findLatestTransactionForRelatedEntity: jest.fn().mockResolvedValue(null),
      getClientPaymentMessage: jest.fn().mockReturnValue('Traitement FlexPay'),
      formatLogPayload: jest.fn().mockReturnValue('{}'),
      formatPaymentLogResponse: jest.fn().mockReturnValue({}),
    };
    manager = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(true),
      create: jest.fn((_entity, payload) => payload),
      save: jest.fn(async (payload) => ({
        id: payload.id ?? 'payout-1',
        ...payload,
      })),
      createQueryBuilder: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(async (work) => work(manager)),
    };

    service = new DriverSettlementsService(
      earningRepository as any,
      payoutRepository as any,
      userRepository as any,
      kycRepository as any,
      bookingRepository as any,
      tripRepository as any,
      configService as any,
      paymentsService as any,
      dataSource as any,
      notificationService as any,
    );
  });

  it('records a driver earning with a 5 percent Zwanga commission', async () => {
    earningRepository.findOne.mockResolvedValue(null);

    const result = await service.recordCompletedBookingEarning({
      id: 'booking-1',
      tripId: 'trip-1',
      passengerId: 'passenger-1',
      numberOfSeats: 1,
      status: BookingStatus.COMPLETED,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentMode: TripPaymentMode.ELECTRONIC,
      paymentAmount: 10000,
      paymentCurrency: 'CDF',
      trip: {
        id: 'trip-1',
        driverId: 'driver-1',
        status: TripStatus.COMPLETED,
      },
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        grossAmount: 10000,
        commissionRate: 0.05,
        commissionAmount: 500,
        netAmount: 9500,
        status: DriverEarningStatus.AVAILABLE,
      }),
    );
  });

  it('notifies the driver once when a post-trip electronic earning becomes available', async () => {
    earningRepository.findOne.mockResolvedValue(null);
    userRepository.findOne.mockResolvedValue({
      id: 'driver-1',
      fcmToken: 'fcm-driver-token',
    });

    await service.recordCompletedBookingEarning({
      id: 'booking-paid-after-trip',
      tripId: 'trip-1',
      passengerId: 'passenger-1',
      numberOfSeats: 1,
      status: BookingStatus.COMPLETED,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentMode: TripPaymentMode.ELECTRONIC,
      paymentAmount: 10000,
      paymentCurrency: 'CDF',
      trip: {
        id: 'trip-1',
        driverId: 'driver-1',
        status: TripStatus.COMPLETED,
      },
    } as any);

    expect(notificationService.sendNotification).toHaveBeenCalledWith(
      'fcm-driver-token',
      'Paiement du trajet confirmé',
      expect.stringContaining('9'),
      expect.objectContaining({
        type: 'driver_booking_earning_confirmed',
        bookingId: 'booking-paid-after-trip',
        amount: 9500,
      }),
      'driver-1',
    );
  });

  it('separates confirmed, cash and pending electronic revenue at trip end', async () => {
    tripRepository.findOne.mockResolvedValue({
      id: 'trip-1',
      driverId: 'driver-1',
      pricePerSeat: 5000,
      isFree: false,
    });
    bookingRepository.find.mockResolvedValue([
      {
        id: 'booking-electronic-paid',
        tripId: 'trip-1',
        status: BookingStatus.COMPLETED,
        numberOfSeats: 2,
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
        paymentAmount: 10000,
      },
      {
        id: 'booking-cash',
        tripId: 'trip-1',
        status: BookingStatus.COMPLETED,
        numberOfSeats: 1,
        paymentMode: TripPaymentMode.CASH,
        paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
        paymentAmount: 5000,
      },
      {
        id: 'booking-electronic-pending',
        tripId: 'trip-1',
        status: BookingStatus.COMPLETED,
        numberOfSeats: 1,
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.PENDING,
        paymentAmount: 5000,
      },
      {
        id: 'booking-no-show',
        tripId: 'trip-1',
        status: BookingStatus.NO_SHOW,
        numberOfSeats: 1,
        paymentMode: TripPaymentMode.CASH,
        paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
        paymentAmount: 5000,
      },
    ]);

    await expect(
      service.getTripRevenueSummary('driver-1', 'trip-1'),
    ).resolves.toEqual(
      expect.objectContaining({
        confirmedAmount: 9500,
        cashToCollectAmount: 5000,
        electronicPendingAmount: 4750,
        totalExpectedAmount: 19250,
        completedBookings: 3,
        currency: 'CDF',
      }),
    );
  });

  it('pushes the authoritative trip revenue amounts to the driver', async () => {
    tripRepository.findOne.mockResolvedValue({
      id: 'trip-1',
      driverId: 'driver-1',
      pricePerSeat: 10000,
      isFree: false,
    });
    bookingRepository.find.mockResolvedValue([
      {
        id: 'booking-cash',
        tripId: 'trip-1',
        status: BookingStatus.COMPLETED,
        numberOfSeats: 1,
        paymentMode: TripPaymentMode.CASH,
        paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
        paymentAmount: 10000,
      },
    ]);
    userRepository.findOne.mockResolvedValue({
      id: 'driver-1',
      fcmToken: 'fcm-driver-token',
    });

    const result = await service.notifyDriverTripRevenue(
      'driver-1',
      'trip-1',
    );

    expect(result).toEqual(
      expect.objectContaining({ cashToCollectAmount: 10000 }),
    );
    expect(notificationService.sendNotification).toHaveBeenCalledWith(
      'fcm-driver-token',
      'Montant du trajet',
      expect.stringContaining('10'),
      expect.objectContaining({
        type: 'driver_trip_revenue',
        tripId: 'trip-1',
        cashToCollectAmount: 10000,
      }),
      'driver-1',
    );
  });

  it('reserves the balance under a driver lock before initiating one payout', async () => {
    let payoutLookupCount = 0;
    manager.findOne.mockImplementation(async (entity) => {
      if (entity === User) {
        return { id: 'driver-1', phone: '+243891234567' };
      }
      if (entity === DriverPayout) {
        payoutLookupCount += 1;
        return payoutLookupCount === 1
          ? null
          : {
              id: 'payout-1',
              driverId: 'driver-1',
              idempotencyKey: '8a94aa7d-dfc2-4fc9-9f71-faf4df306907',
              amount: 9500,
              currency: 'CDF',
              phone: '+243891234567',
              status: DriverPayoutStatus.PENDING,
              paymentTransactionId: null,
              paymentTransaction: null,
              requestedAt: new Date(),
              processedAt: null,
              failureReason: null,
            };
      }
      return null;
    });
    const sums = [{ sum: '10000' }, { sum: '0' }];
    manager.createQueryBuilder.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(sums.shift()),
    }));
    paymentsService.initiatePayout.mockResolvedValue({
      id: 'payment-1',
      userId: 'driver-1',
      purpose: PaymentPurpose.DRIVER_PAYOUT,
      relatedEntityType: 'driver_payout',
      relatedEntityId: 'payout-1',
      method: PaymentMethod.MOBILE_MONEY,
      status: PaymentStatus.INITIATED,
      orderNumber: 'PAYOUT123',
      providerMessage: 'Transaction envoyee',
      paidAt: null,
    });

    const payout = await service.requestPayout('driver-1', {
      amount: 9500,
      idempotencyKey: '8a94aa7d-dfc2-4fc9-9f71-faf4df306907',
    });

    expect(manager.findOne).toHaveBeenCalledWith(
      User,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(paymentsService.initiatePayout).toHaveBeenCalledTimes(1);
    expect(paymentsService.initiatePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        relatedEntityId: 'payout-1',
        phone: '+243891234567',
        amount: 9500,
      }),
    );
    expect(payout.status).toBe(DriverPayoutStatus.INITIATED);
    expect(payout.orderNumber).toBe('PAYOUT123');
  });

  it('reuses an existing idempotent payout without sending money twice', async () => {
    const payment = {
      id: 'payment-1',
      userId: 'driver-1',
      purpose: PaymentPurpose.DRIVER_PAYOUT,
      relatedEntityType: 'driver_payout',
      relatedEntityId: 'payout-1',
      method: PaymentMethod.MOBILE_MONEY,
      status: PaymentStatus.INITIATED,
      orderNumber: 'PAYOUT123',
      providerMessage: 'Transaction envoyee',
      paidAt: null,
    };
    const existing = {
      id: 'payout-1',
      driverId: 'driver-1',
      idempotencyKey: '8a94aa7d-dfc2-4fc9-9f71-faf4df306907',
      amount: 9500,
      currency: 'CDF',
      phone: '+243891234567',
      status: DriverPayoutStatus.INITIATED,
      paymentTransactionId: 'payment-1',
      paymentTransaction: payment,
      requestedAt: new Date(),
      processedAt: null,
      failureReason: null,
    };
    manager.findOne.mockImplementation(async (entity) => {
      if (entity === User) {
        return { id: 'driver-1', phone: '+243891234567' };
      }
      if (entity === DriverPayout) {
        return existing;
      }
      return null;
    });

    const payout = await service.requestPayout('driver-1', {
      amount: 9500,
      idempotencyKey: '8a94aa7d-dfc2-4fc9-9f71-faf4df306907',
    });

    expect(paymentsService.initiatePayout).not.toHaveBeenCalled();
    expect(payout.id).toBe('payout-1');
    expect(payout.orderNumber).toBe('PAYOUT123');
  });

  it('releases an orphan reservation only when no payment transaction was created', async () => {
    const orphan = {
      id: 'payout-orphan',
      driverId: 'driver-1',
      idempotencyKey: '8a94aa7d-dfc2-4fc9-9f71-faf4df306907',
      amount: 9500,
      currency: 'CDF',
      phone: '+243891234567',
      status: DriverPayoutStatus.PENDING,
      paymentTransactionId: null,
      paymentTransaction: null,
      requestedAt: new Date(Date.now() - 20 * 60 * 1000),
      processedAt: null,
      failureReason: null,
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    payoutRepository.find.mockResolvedValue([orphan]);
    manager.findOne.mockImplementation(async (entity) => {
      if (entity === DriverPayout) return orphan;
      if (entity === PaymentTransaction) return null;
      return null;
    });

    await service.reconcilePendingPayouts();

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'payout-orphan',
        status: DriverPayoutStatus.FAILED,
        processedAt: expect.any(Date),
      }),
    );
    expect(paymentsService.initiatePayout).not.toHaveBeenCalled();
  });
});
