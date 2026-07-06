import { BookingPaymentStatus, BookingStatus } from './entities/booking.entity';
import { BookingsService } from './bookings.service';
import { TripStatus } from '../trips/entities/trip.entity';
import {
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
} from '../payments/entities/payment-transaction.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';

describe('BookingsService trip payments', () => {
  let bookingRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let cacheService: { del: jest.Mock };
  let configService: { get: jest.Mock };
  let paymentsService: {
    initiatePayment: jest.Mock;
    checkPaymentStatus: jest.Mock;
    getClientPaymentMessage: jest.Mock;
    findTransactionById: jest.Mock;
    findLatestTransactionForRelatedEntity: jest.Mock;
  };
  let walletService: {
    payForBooking: jest.Mock;
    refundBookingPayment: jest.Mock;
    awardLoyaltyForBooking: jest.Mock;
  };
  let driverSettlementsService: {
    recordCompletedBookingEarning: jest.Mock;
  };
  let service: BookingsService;

  const booking = {
    id: 'booking-1',
    tripId: 'trip-1',
    passengerId: 'passenger-1',
    numberOfSeats: 2,
    status: BookingStatus.ACCEPTED,
    paymentStatus: BookingPaymentStatus.PENDING,
    paymentAmount: 5000,
    paymentCurrency: 'CDF',
    paymentMode: TripPaymentMode.ELECTRONIC,
    paymentReference: null,
    paymentTransactionId: null,
    paidAt: null,
    trip: {
      id: 'trip-1',
      status: TripStatus.PENDING,
      isFree: false,
      pricePerSeat: 2500,
      departureLocation: 'Gombe',
      arrivalLocation: "N'djili",
    },
  };

  beforeEach(() => {
    bookingRepository = {
      findOne: jest.fn(),
      save: jest.fn((payload: unknown) => Promise.resolve(payload)),
      remove: jest.fn((payload: unknown) => Promise.resolve(payload)),
    };
    cacheService = { del: jest.fn() };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'FLEXPAY_CALLBACK_BASE_URL') {
          return 'https://api.zwanga.cd/api/v1';
        }
        return undefined;
      }),
    };
    paymentsService = {
      initiatePayment: jest.fn(),
      checkPaymentStatus: jest.fn(),
      getClientPaymentMessage: jest.fn().mockReturnValue('Paiement confirme'),
      findTransactionById: jest.fn(),
      findLatestTransactionForRelatedEntity: jest.fn(),
    };
    walletService = {
      payForBooking: jest.fn(),
      refundBookingPayment: jest.fn(),
      awardLoyaltyForBooking: jest.fn(),
    };
    driverSettlementsService = {
      recordCompletedBookingEarning: jest.fn(),
    };

    service = new BookingsService(
      bookingRepository as any,
      {} as any,
      {} as any,
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      configService as any,
      paymentsService as any,
      walletService as any,
      driverSettlementsService as any,
    );
  });

  it('calculates the booking amount on the backend when initiating payment', async () => {
    bookingRepository.findOne.mockResolvedValue({ ...booking });
    paymentsService.initiatePayment.mockResolvedValue({
      id: 'payment-1',
      method: PaymentMethod.MOBILE_MONEY,
      status: PaymentStatus.INITIATED,
      reference: 'TRIP123',
      orderNumber: 'ORDER123',
      providerStatusCode: '0',
      providerMessage: 'Demande envoyee',
      paymentUrl: null,
      amount: 5000,
      currency: 'CDF',
      paidAt: null,
    });

    const result = await service.initiateBookingPayment(
      'booking-1',
      'passenger-1',
      {
        method: PaymentMethod.MOBILE_MONEY,
        phone: '+243891234567',
      },
    );

    expect(paymentsService.initiatePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'passenger-1',
        purpose: PaymentPurpose.TRIP_BOOKING,
        relatedEntityType: 'booking',
        relatedEntityId: 'booking-1',
        method: PaymentMethod.MOBILE_MONEY,
        amount: 5000,
        currency: 'CDF',
        callbackUrl: 'https://api.zwanga.cd/api/v1/bookings/flexpay/callback',
      }),
    );
    expect(result.booking.paymentStatus).toBe(BookingPaymentStatus.INITIATED);
    expect(result.payment.amount).toBe(5000);
  });

  it('rejects FlexPay for a booking payable in cash on arrival', async () => {
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.CASH,
    });

    await expect(
      service.initiateBookingPayment('booking-1', 'passenger-1', {
        method: PaymentMethod.MOBILE_MONEY,
        phone: '+243891234567',
      }),
    ).rejects.toThrow('Cette reservation doit etre reglee en especes');

    expect(paymentsService.initiatePayment).not.toHaveBeenCalled();
  });

  it('marks the booking paid after a successful FlexPay status check', async () => {
    const paidAt = new Date('2026-06-29T10:00:00.000Z');
    const payment = {
      id: 'payment-1',
      purpose: PaymentPurpose.TRIP_BOOKING,
      relatedEntityType: 'booking',
      relatedEntityId: 'booking-1',
      method: PaymentMethod.MOBILE_MONEY,
      status: PaymentStatus.SUCCEEDED,
      reference: 'TRIP123',
      orderNumber: 'ORDER123',
      providerStatusCode: '0',
      providerMessage: 'Paiement confirme',
      paymentUrl: null,
      amount: 5000,
      currency: 'CDF',
      paidAt,
    };
    paymentsService.checkPaymentStatus.mockResolvedValue(payment);
    bookingRepository.findOne.mockResolvedValue({ ...booking });

    const result = await service.checkBookingPaymentStatus(
      'passenger-1',
      'ORDER123',
    );

    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
        paymentReference: 'TRIP123',
        paymentTransactionId: 'payment-1',
        paidAt,
      }),
    );
    expect(result.booking.paymentStatus).toBe(BookingPaymentStatus.SUCCEEDED);
    expect(result.payment.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('blocks pickup when an electronic booking has not been paid', async () => {
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentStatus: BookingPaymentStatus.PENDING,
      trip: {
        ...booking.trip,
        driverId: 'driver-1',
      },
    });

    await expect(
      service.confirmPickup('booking-1', 'driver-1'),
    ).rejects.toThrow('doit etre payee avant le demarrage');

    expect(bookingRepository.save).not.toHaveBeenCalled();
  });

  it('finalizes a completed prepaid booking with loyalty and driver earning', async () => {
    await (service as any).finalizeCompletedBooking({
      ...booking,
      status: BookingStatus.COMPLETED,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
      paymentMode: TripPaymentMode.ELECTRONIC,
      trip: {
        ...booking.trip,
        driverId: 'driver-1',
      },
    });

    expect(walletService.awardLoyaltyForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
      5000,
    );
    expect(
      driverSettlementsService.recordCompletedBookingEarning,
    ).toHaveBeenCalledWith(expect.objectContaining({ id: 'booking-1' }));
  });
});
