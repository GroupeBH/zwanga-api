import {
  Booking,
  BookingPaymentStatus,
  BookingStatus,
} from './entities/booking.entity';
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
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    manager?: unknown;
  };
  let cacheService: { del: jest.Mock };
  let configService: { get: jest.Mock };
  let paymentsService: {
    initiatePayment: jest.Mock;
    checkPaymentStatus: jest.Mock;
    getClientPaymentMessage: jest.Mock;
    findTransactionById: jest.Mock;
    findLatestTransactionForRelatedEntity: jest.Mock;
    formatLogPayload: jest.Mock;
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
      find: jest.fn(),
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
      formatLogPayload: jest.fn((payload: unknown) => JSON.stringify(payload)),
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

  it('deducts seats when the driver accepts a pending booking', async () => {
    const trip = {
      id: 'trip-1',
      driverId: 'driver-1',
      status: TripStatus.PENDING,
      totalSeats: 4,
      availableSeats: 4,
    };
    const pendingBooking = {
      id: 'booking-1',
      tripId: 'trip-1',
      passengerId: 'passenger-1',
      numberOfSeats: 2,
      status: BookingStatus.PENDING,
      acceptedAt: null,
      cancelledAt: null,
      rejectionReason: null,
      trip,
    };
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ seats: 0 }),
    };
    const transactionBookingRepository = {
      findOne: jest.fn().mockResolvedValue(pendingBooking),
      save: jest.fn(async (payload) => payload),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const transactionTripRepository = {
      findOne: jest.fn().mockResolvedValue(trip),
      save: jest.fn(async (payload) => payload),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === Booking
          ? transactionBookingRepository
          : transactionTripRepository,
      ),
    };
    bookingRepository.manager = {
      transaction: jest.fn((callback) => callback(manager)),
    };

    const result = await service.updateStatus('booking-1', 'driver-1', {
      status: BookingStatus.ACCEPTED,
    });

    expect(result.status).toBe(BookingStatus.ACCEPTED);
    expect(transactionTripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ availableSeats: 2 }),
    );
    expect(transactionBookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BookingStatus.ACCEPTED,
        acceptedAt: expect.any(Date),
      }),
    );
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

  it('blocks driver dropoff confirmation until the passenger requests dropoff', async () => {
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      trip: {
        ...booking.trip,
        driverId: 'driver-1',
      },
    });

    await expect(
      service.confirmDropoff('booking-1', 'driver-1'),
    ).rejects.toThrow("Le passager doit d'abord signaler son arrivée");

    expect(bookingRepository.save).not.toHaveBeenCalled();
  });

  it('lets the passenger request dropoff without completing the booking', async () => {
    const finalizeCompletedBookingSpy = jest
      .spyOn(service as any, 'finalizeCompletedBooking')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyDriverAboutDropoffConfirmation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'touchTripInteraction')
      .mockResolvedValue(undefined);

    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      trip: {
        ...booking.trip,
        driverId: 'driver-1',
      },
    });

    const result = await service.confirmDropoffByPassenger(
      'booking-1',
      'passenger-1',
      { paymentMode: TripPaymentMode.CASH },
    );

    expect(result.droppedOffConfirmedByPassenger).toBe(true);
    expect(result.droppedOff).toBe(false);
    expect(result.status).toBe(BookingStatus.ACCEPTED);
    expect(finalizeCompletedBookingSpy).not.toHaveBeenCalled();
  });

  it('finalizes the booking when the driver confirms a passenger-requested dropoff', async () => {
    const finalizeCompletedBookingSpy = jest
      .spyOn(service as any, 'finalizeCompletedBooking')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifySelectedEmergencyContacts')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyPassengerAboutDropoffConfirmation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'touchTripInteraction')
      .mockResolvedValue(undefined);

    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: false,
      droppedOffConfirmedByPassenger: true,
      trip: {
        ...booking.trip,
        driverId: 'driver-1',
      },
    });

    const result = await service.confirmDropoff('booking-1', 'driver-1');

    expect(result.droppedOff).toBe(true);
    expect(result.status).toBe(BookingStatus.COMPLETED);
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        droppedOff: true,
        status: BookingStatus.COMPLETED,
      }),
    );
    expect(finalizeCompletedBookingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
    );
  });

  it('automatically confirms pickup when driver and passenger GPS stay together after moving from pickup', async () => {
    jest
      .spyOn(service as any, 'notifySelectedEmergencyContacts')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyDriverEmergencyContactsOnPickup')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyPassengerAboutAutomaticPickupConfirmation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyDriverAboutAutomaticPickupConfirmation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'touchTripInteraction')
      .mockResolvedValue(undefined);

    const now = new Date();
    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: false,
      pickedUpConfirmedByPassenger: false,
      passengerOriginPoint: { type: 'Point', coordinates: [15.3, -4.3] },
      passengerCurrentLocation: {
        type: 'Point',
        coordinates: [15.302, -4.3],
      },
      passengerLastLocationUpdateAt: now,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.30201, -4.3] },
        lastLocationUpdateAt: now,
        departurePoint: { type: 'Point', coordinates: [15.3, -4.3] },
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'parties_nearby',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
      }),
      {
        type: 'pickup_confirmed',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
      },
    ]);
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        pickedUp: true,
        pickedUpConfirmedByPassenger: true,
      }),
    );
  });

  it('emits a pickup arrival event when the driver reaches the passenger pickup point', async () => {
    const now = new Date();
    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: false,
      pickedUpConfirmedByPassenger: false,
      passengerOriginPoint: { type: 'Point', coordinates: [15.3, -4.3] },
      passengerCurrentLocation: null,
      passengerLastLocationUpdateAt: null,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.3001, -4.3] },
        lastLocationUpdateAt: now,
        departurePoint: { type: 'Point', coordinates: [15.3, -4.3] },
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'driver_arrived_pickup',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
        expiresAt: expect.any(String),
        pickupWaitSeconds: 600,
      }),
    ]);
    expect(bookingRepository.save).not.toHaveBeenCalled();
  });

  it('emits a driver-near-pickup event when the driver is within 200 meters of pickup', async () => {
    const now = new Date();
    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: false,
      pickedUpConfirmedByPassenger: false,
      passengerOriginPoint: { type: 'Point', coordinates: [15.3, -4.3] },
      passengerCurrentLocation: null,
      passengerLastLocationUpdateAt: null,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.30135, -4.3] },
        lastLocationUpdateAt: now,
        departurePoint: { type: 'Point', coordinates: [15.3, -4.3] },
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'driver_near_pickup',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
      }),
    ]);
    expect(bookingRepository.save).not.toHaveBeenCalled();
  });

  it('automatically completes dropoff when passenger and driver arrive together at destination', async () => {
    const finalizeCompletedBookingSpy = jest
      .spyOn(service as any, 'finalizeCompletedBooking')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifySelectedEmergencyContacts')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyPassengerAboutAutomaticDropoffConfirmation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyDriverAboutAutomaticDropoffConfirmation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'touchTripInteraction')
      .mockResolvedValue(undefined);

    const now = new Date();
    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: {
        type: 'Point',
        coordinates: [15.3101, -4.31],
      },
      passengerLastLocationUpdateAt: now,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.31012, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      {
        type: 'dropoff_confirmed',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
      },
    ]);
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        droppedOff: true,
        droppedOffConfirmedByPassenger: true,
        status: BookingStatus.COMPLETED,
      }),
    );
    expect(finalizeCompletedBookingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
    );
  });
});
