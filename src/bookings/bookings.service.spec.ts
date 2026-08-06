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
    update: jest.Mock;
    manager?: unknown;
  };
  let tripRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let cacheService: { del: jest.Mock };
  let locationHistoryService: {
    recordPassengerLocation: jest.Mock;
    getDriverLocationHistory: jest.Mock;
    getPassengerLocationHistory: jest.Mock;
    getBoardingCandidate: jest.Mock;
    saveBoardingCandidate: jest.Mock;
  };
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
    creditBookingFareAdjustment: jest.Mock;
    awardLoyaltyForBooking: jest.Mock;
  };
  let googleMapsService: { getDirections: jest.Mock };
  let driverSettlementsService: {
    recordCompletedBookingEarning: jest.Mock;
  };
  let service: BookingsService;
  let boardingCandidates: Map<string, unknown>;

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
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      remove: jest.fn((payload: unknown) => Promise.resolve(payload)),
    };
    tripRepository = {
      findOne: jest.fn(),
      save: jest.fn((payload: unknown) => Promise.resolve(payload)),
    };
    cacheService = { del: jest.fn() };
    boardingCandidates = new Map<string, unknown>();
    locationHistoryService = {
      recordPassengerLocation: jest.fn().mockResolvedValue(undefined),
      getDriverLocationHistory: jest.fn().mockResolvedValue(null),
      getPassengerLocationHistory: jest.fn().mockResolvedValue(null),
      getBoardingCandidate: jest.fn(
        async (tripId: string, driverId: string, passengerId: string) =>
          boardingCandidates.get(`${tripId}:${driverId}:${passengerId}`) ?? null,
      ),
      saveBoardingCandidate: jest.fn(
        async (
          tripId: string,
          driverId: string,
          passengerId: string,
          candidate: unknown,
        ) => {
          boardingCandidates.set(
            `${tripId}:${driverId}:${passengerId}`,
            candidate,
          );
        },
      ),
    };
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
      creditBookingFareAdjustment: jest.fn(),
      awardLoyaltyForBooking: jest.fn(),
    };
    googleMapsService = {
      getDirections: jest.fn(),
    };
    driverSettlementsService = {
      recordCompletedBookingEarning: jest.fn(),
    };

    service = new BookingsService(
      bookingRepository as any,
      tripRepository as any,
      {} as any,
      {} as any,
      {} as any,
      cacheService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      googleMapsService as any,
      configService as any,
      paymentsService as any,
      walletService as any,
      driverSettlementsService as any,
      locationHistoryService as any,
    );
  });

  const buildLocationHistory = (
    previousCoordinates: [number, number],
    currentCoordinates: [number, number],
    recordedAt: Date,
  ) => {
    const previous = {
      longitude: previousCoordinates[0],
      latitude: previousCoordinates[1],
      recordedAt: recordedAt.toISOString(),
      accuracyMeters: 5,
      speedMetersPerSecond: 0,
      headingDegrees: null,
    };
    const current = {
      longitude: currentCoordinates[0],
      latitude: currentCoordinates[1],
      recordedAt: recordedAt.toISOString(),
      accuracyMeters: 5,
      speedMetersPerSecond: 0,
      headingDegrees: null,
    };
    return { previous, current, samples: [previous, current] };
  };

  it.each([
    TripPaymentMode.ELECTRONIC,
    TripPaymentMode.POINTS,
    TripPaymentMode.CASH,
  ])(
    'charges only the travelled kilometers after an interruption paid by %s',
    async (paymentMode) => {
      const originPoint = {
        type: 'Point' as const,
        coordinates: [15.2663, -4.325],
      };
      const destinationPoint = {
        type: 'Point' as const,
        coordinates: [15.3663, -4.425],
      };
      const interruptionPoint = {
        type: 'Point' as const,
        coordinates: [15.3063, -4.365],
      };
      const interruptedBooking = {
        ...booking,
        numberOfSeats: 1,
        pickedUp: true,
        paymentMode,
        paymentStatus:
          paymentMode === TripPaymentMode.CASH
            ? BookingPaymentStatus.NOT_REQUIRED
            : BookingPaymentStatus.SUCCEEDED,
        paymentAmount: 10000,
        passengerOriginPoint: originPoint,
        passengerDestinationPoint: destinationPoint,
        trip: {
          ...booking.trip,
          driverId: 'driver-1',
          status: TripStatus.ACTIVE,
          pricePerSeat: 10000,
          departurePoint: originPoint,
          arrivalPoint: destinationPoint,
          currentLocation: interruptionPoint,
        },
      };
      bookingRepository.findOne.mockResolvedValue(interruptedBooking);
      googleMapsService.getDirections
        .mockResolvedValueOnce({
          routes: [{ legs: [{ distance: 10000 }] }],
        })
        .mockResolvedValueOnce({
          routes: [{ legs: [{ distance: 4000 }] }],
        });
      jest
        .spyOn(service as any, 'touchTripInteraction')
        .mockResolvedValue(undefined);

      const result = await service.completeBookingByTripInterruption(
        'booking-1',
        interruptionPoint as any,
      );

      expect(result).toEqual(
        expect.objectContaining({
          status: BookingStatus.COMPLETED,
          originalPaymentAmount: 10000,
          paymentAmount: 4000,
          plannedDistanceMeters: 10000,
          travelledDistanceMeters: 4000,
          pricePerKilometer: 1000,
          fareAdjustmentAmount: 6000,
          fareAdjustedAt: expect.any(Date),
        }),
      );
      if (paymentMode === TripPaymentMode.CASH) {
        expect(
          walletService.creditBookingFareAdjustment,
        ).not.toHaveBeenCalled();
      } else {
        expect(walletService.creditBookingFareAdjustment).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'booking-1', paymentAmount: 4000 }),
          6000,
        );
      }
      expect(walletService.awardLoyaltyForBooking).toHaveBeenCalledWith(
        expect.objectContaining({ paymentAmount: 4000 }),
        4000,
      );
      expect(
        driverSettlementsService.recordCompletedBookingEarning,
      ).toHaveBeenCalledWith(expect.objectContaining({ paymentAmount: 4000 }));
    },
  );

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

  it('lets a cash booking switch to mobile money payment', async () => {
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
    });
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
        method: PaymentMethod.MOBILE_MONEY,
        amount: 5000,
        currency: 'CDF',
      }),
    );
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.INITIATED,
        paymentReference: 'TRIP123',
        paymentTransactionId: 'payment-1',
      }),
    );
    expect(result.booking).toEqual(
      expect.objectContaining({
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.INITIATED,
      }),
    );
  });

  it('rejects FlexPay for a booking already paid with points', async () => {
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.POINTS,
      paymentStatus: BookingPaymentStatus.SUCCEEDED,
    });

    await expect(
      service.initiateBookingPayment('booking-1', 'passenger-1', {
        method: PaymentMethod.MOBILE_MONEY,
        phone: '+243891234567',
      }),
    ).rejects.toThrow('points Zwanga');

    expect(paymentsService.initiatePayment).not.toHaveBeenCalled();
  });

  it('lets the passenger pay an existing booking with points', async () => {
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
    });

    const result = await service.updatePaymentMode(
      'booking-1',
      'passenger-1',
      TripPaymentMode.POINTS,
    );

    expect(walletService.payForBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-1',
        passengerId: 'passenger-1',
        paymentMode: TripPaymentMode.POINTS,
      }),
      5000,
    );
    expect(result).toEqual(
      expect.objectContaining({
        paymentMode: TripPaymentMode.POINTS,
        paymentAmount: 5000,
        paymentCurrency: 'CDF',
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
      }),
    );
    expect(result.paidAt).toBeInstanceOf(Date);
    expect(paymentsService.initiatePayment).not.toHaveBeenCalled();
  });

  it('keeps the booking unpaid when the points balance is insufficient', async () => {
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
    });
    walletService.payForBooking.mockRejectedValue(
      new Error('Solde de points insuffisant pour payer ce trajet'),
    );

    await expect(
      service.updatePaymentMode(
        'booking-1',
        'passenger-1',
        TripPaymentMode.POINTS,
      ),
    ).rejects.toThrow('Solde de points insuffisant');

    expect(bookingRepository.save).not.toHaveBeenCalled();
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

  it('finalizes loyalty when a completed booking receives a late FlexPay confirmation', async () => {
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
    bookingRepository.findOne.mockResolvedValue({
      ...booking,
      status: BookingStatus.COMPLETED,
      paymentMode: TripPaymentMode.ELECTRONIC,
      paymentStatus: BookingPaymentStatus.INITIATED,
      trip: {
        ...booking.trip,
        driverId: 'driver-1',
      },
    });

    await service.checkBookingPaymentStatus('passenger-1', 'ORDER123');

    expect(walletService.awardLoyaltyForBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-1',
        paymentMode: TripPaymentMode.ELECTRONIC,
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
      }),
      5000,
    );
    expect(
      driverSettlementsService.recordCompletedBookingEarning,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'booking-1',
        paymentStatus: BookingPaymentStatus.SUCCEEDED,
      }),
    );
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

  it('lets the driver complete dropoff without waiting for a passenger button', async () => {
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
      pickedUpConfirmedByPassenger: false,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      trip: {
        ...booking.trip,
        driverId: 'driver-1',
      },
    });

    const result = await service.confirmDropoff('booking-1', 'driver-1');

    expect(result.droppedOff).toBe(true);
    expect(result.droppedOffConfirmedByPassenger).toBe(true);
    expect(result.status).toBe(BookingStatus.COMPLETED);
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        droppedOff: true,
        pickedUpConfirmedByPassenger: true,
        droppedOffConfirmedByPassenger: true,
        status: BookingStatus.COMPLETED,
      }),
    );
    expect(finalizeCompletedBookingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
    );
  });

  it('lets the passenger complete dropoff without waiting for a driver button', async () => {
    const finalizeCompletedBookingSpy = jest
      .spyOn(service as any, 'finalizeCompletedBooking')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifySelectedEmergencyContacts')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyDriverAboutDropoffConfirmation')
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
    expect(result.droppedOff).toBe(true);
    expect(result.status).toBe(BookingStatus.COMPLETED);
    expect(finalizeCompletedBookingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
    );
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
    locationHistoryService.getDriverLocationHistory.mockResolvedValue(
      buildLocationHistory([15.3005, -4.3], [15.30201, -4.3], now),
    );
    locationHistoryService.getPassengerLocationHistory.mockResolvedValue(
      buildLocationHistory([15.3005, -4.3], [15.302, -4.3], now),
    );
    (service as any).boardingDetectionConfig = {
      ...(service as any).boardingDetectionConfig,
      minimumValidSamples: 3,
      minimumSharedMovementDurationMs: 0,
    };
    const initialRecordedAt = new Date(now.getTime() - 21_000).toISOString();
    boardingCandidates.set('trip-1:driver-1:passenger-1', {
      state: 'BOARDING_CANDIDATE',
      previousState: 'DRIVER_APPROACHING',
      createdAt: initialRecordedAt,
      updatedAt: initialRecordedAt,
      initialDriverLocation: {
        latitude: -4.3,
        longitude: 15.3,
        recordedAt: initialRecordedAt,
        accuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: null,
      },
      initialPassengerLocation: {
        latitude: -4.3,
        longitude: 15.300005,
        recordedAt: initialRecordedAt,
        accuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: null,
      },
      sharedMovementStartedAt: initialRecordedAt,
      separationStartedAt: null,
      confirmedAt: null,
    });
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
      expect.objectContaining({
        type: 'pickup_confirmed',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
        boardingState: 'BOARDING_CONFIRMED',
        confidenceScore: expect.any(Number),
      }),
    ]);
    expect(bookingRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
      expect.objectContaining({
        pickedUp: true,
        pickedUpConfirmedByPassenger: true,
      }),
    );
  });

  it('emits the automatic pickup only once when a stale evaluation retries the same confirmation', async () => {
    const notifyPassenger = jest
      .spyOn(service as any, 'notifyPassengerAboutAutomaticPickupConfirmation')
      .mockResolvedValue(undefined);
    const notifyDriver = jest
      .spyOn(service as any, 'notifyDriverAboutAutomaticPickupConfirmation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifySelectedEmergencyContacts')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyDriverEmergencyContactsOnPickup')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'touchTripInteraction')
      .mockResolvedValue(undefined);

    const now = new Date();
    const initialRecordedAt = new Date(now.getTime() - 21_000).toISOString();
    const readyCandidate = {
      state: 'SHARED_MOVEMENT_DETECTED',
      previousState: 'BOARDING_CANDIDATE',
      createdAt: initialRecordedAt,
      updatedAt: initialRecordedAt,
      initialDriverLocation: {
        latitude: -4.3,
        longitude: 15.3,
        recordedAt: initialRecordedAt,
        accuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: 90,
      },
      initialPassengerLocation: {
        latitude: -4.3,
        longitude: 15.300005,
        recordedAt: initialRecordedAt,
        accuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: 90,
      },
      sharedMovementStartedAt: initialRecordedAt,
      separationStartedAt: null,
      confirmedAt: null,
    };
    const samples = [0, 0.001, 0.002].map((longitudeOffset, index) => ({
      longitude: 15.3 + longitudeOffset,
      latitude: -4.3,
      recordedAt: new Date(now.getTime() - (2 - index) * 3_000).toISOString(),
      accuracyMeters: 5,
      speedMetersPerSecond: 12,
      headingDegrees: 90,
    }));
    const passengerSamples = samples.map((sample) => ({
      ...sample,
      longitude: sample.longitude + 0.000005,
    }));
    locationHistoryService.getDriverLocationHistory.mockResolvedValue({
      previous: samples.at(-2),
      current: samples.at(-1),
      samples,
    });
    locationHistoryService.getPassengerLocationHistory.mockResolvedValue({
      previous: passengerSamples.at(-2),
      current: passengerSamples.at(-1),
      samples: passengerSamples,
    });
    (service as any).boardingDetectionConfig = {
      ...(service as any).boardingDetectionConfig,
      minimumValidSamples: 3,
      minimumSharedMovementDurationMs: 0,
    };

    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: false,
      pickedUpConfirmedByPassenger: false,
      passengerOriginPoint: { type: 'Point', coordinates: [15.3, -4.3] },
      passengerCurrentLocation: {
        type: 'Point',
        coordinates: [15.302005, -4.3],
      },
      passengerLastLocationUpdateAt: now,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.302, -4.3] },
        lastLocationUpdateAt: now,
        departurePoint: { type: 'Point', coordinates: [15.3, -4.3] },
      },
    };

    boardingCandidates.set(
      'trip-1:driver-1:passenger-1',
      structuredClone(readyCandidate),
    );
    bookingRepository.update
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });

    const firstEvent = await (service as any).tryConfirmAutomaticPickup(
      autoBooking,
    );

    autoBooking.pickedUp = false;
    autoBooking.pickedUpConfirmedByPassenger = false;
    boardingCandidates.set(
      'trip-1:driver-1:passenger-1',
      structuredClone(readyCandidate),
    );
    const retryEvent = await (service as any).tryConfirmAutomaticPickup(
      autoBooking,
    );

    expect(firstEvent).toEqual(
      expect.objectContaining({
        type: 'pickup_confirmed',
        boardingState: 'BOARDING_CONFIRMED',
      }),
    );
    expect(retryEvent).toBeNull();
    expect(bookingRepository.update).toHaveBeenCalledTimes(2);
    expect(notifyPassenger).toHaveBeenCalledTimes(1);
    expect(notifyDriver).toHaveBeenCalledTimes(1);
  });

  it('automatically confirms pickup when both users start together and then move in small coherent samples', async () => {
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

    const pickup: [number, number] = [15.3, -4.3];
    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: false,
      pickedUpConfirmedByPassenger: false,
      passengerOriginPoint: { type: 'Point', coordinates: pickup },
      passengerCurrentLocation: { type: 'Point', coordinates: pickup },
      passengerLastLocationUpdateAt: new Date(),
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: pickup },
        lastLocationUpdateAt: new Date(),
        departurePoint: { type: 'Point', coordinates: pickup },
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const emittedEvents: Array<{ type: string }> = [];
    const driverSamples: any[] = [];
    const passengerSamples: any[] = [];
    const baseTime = Date.now();
    jest.useFakeTimers({ now: baseTime });

    try {
      for (let sampleIndex = 0; sampleIndex < 12; sampleIndex += 1) {
        const longitudeOffset =
          sampleIndex < 2 ? 0 : (sampleIndex - 1) * 0.0001;
        const driver: [number, number] = [15.3 + longitudeOffset, -4.3];
        const passenger: [number, number] = [
          15.3 + longitudeOffset + 0.000005,
          -4.3,
        ];
        const recordedAt = new Date(baseTime + sampleIndex * 3_000);
        jest.setSystemTime(recordedAt);

        const driverSample = {
          longitude: driver[0],
          latitude: driver[1],
          recordedAt: recordedAt.toISOString(),
          accuracyMeters: 5,
          speedMetersPerSecond: sampleIndex < 2 ? 0 : 3.7,
          headingDegrees: 90,
        };
        const passengerSample = {
          longitude: passenger[0],
          latitude: passenger[1],
          recordedAt: recordedAt.toISOString(),
          accuracyMeters: 5,
          speedMetersPerSecond: sampleIndex < 2 ? 0 : 3.7,
          headingDegrees: 90,
        };
        driverSamples.push(driverSample);
        passengerSamples.push(passengerSample);

        autoBooking.trip.currentLocation = {
          type: 'Point',
          coordinates: driver,
        };
        autoBooking.trip.lastLocationUpdateAt = recordedAt;
        autoBooking.passengerCurrentLocation = {
          type: 'Point',
          coordinates: passenger,
        };
        autoBooking.passengerLastLocationUpdateAt = recordedAt;
        locationHistoryService.getDriverLocationHistory.mockResolvedValue({
          previous: driverSamples.at(-2) ?? null,
          current: driverSample,
          samples: driverSamples.slice(-10),
        });
        locationHistoryService.getPassengerLocationHistory.mockResolvedValue({
          previous: passengerSamples.at(-2) ?? null,
          current: passengerSample,
          samples: passengerSamples.slice(-10),
        });

        const result = await service.evaluateAutomaticRideProgressForTrip(
          'trip-1',
        );
        emittedEvents.push(...result.events);
      }
    } finally {
      jest.useRealTimers();
    }

    expect(emittedEvents.filter((event) => event.type === 'pickup_confirmed')).toHaveLength(1);
    expect(autoBooking.pickedUp).toBe(true);
    expect(autoBooking.pickedUpConfirmedByPassenger).toBe(true);
  });

  it('does not automatically confirm pickup when the driver leaves pickup without a fresh passenger location', async () => {
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
      driverPickupArrivedAt: new Date(now.getTime() - 60 * 1000),
      passengerOriginPoint: { type: 'Point', coordinates: [15.3, -4.3] },
      passengerCurrentLocation: null,
      passengerLastLocationUpdateAt: null,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.302, -4.3] },
        lastLocationUpdateAt: now,
        departurePoint: { type: 'Point', coordinates: [15.3, -4.3] },
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([]);
    expect(bookingRepository.save).not.toHaveBeenCalled();
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
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        driverPickupArrivedAt: expect.any(Date),
      }),
    );
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

  it('emits a passenger destination warning when the vehicle is within 20 meters', async () => {
    const now = new Date();
    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      passengerDestinationApproachNotifiedAt: null,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: null,
      passengerLastLocationUpdateAt: null,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.31015, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'passenger_near_destination',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
      }),
    ]);
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        passengerDestinationApproachNotifiedAt: expect.any(Date),
      }),
    );
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.ACTIVE,
        destinationApproachNotifiedAt: expect.any(Date),
      }),
    );
  });

  it('does not automatically complete dropoff while driver and passenger remain together at the destination', async () => {
    const now = new Date();
    const autoBooking = {
      ...booking,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      passengerDestinationApproachNotifiedAt: now,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: {
        type: 'Point',
        coordinates: [15.31005, -4.31],
      },
      passengerLastLocationUpdateAt: now,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.31005, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
        destinationApproachNotifiedAt: now,
        destinationReachedAt: null,
      },
    };
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([]);
    expect(bookingRepository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        droppedOff: true,
        status: BookingStatus.COMPLETED,
      }),
    );
  });

  it('automatically completes dropoff and the trip after the driver continues past the passenger destination', async () => {
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
      pickedUpConfirmedByPassenger: false,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      passengerDestinationApproachNotifiedAt: now,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: {
        type: 'Point',
        coordinates: [15.31, -4.31],
      },
      passengerLastLocationUpdateAt: now,
      trip: {
        ...booking.trip,
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.31065, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
        destinationApproachNotifiedAt: now,
        destinationReachedAt: now,
      },
    };
    locationHistoryService.getDriverLocationHistory.mockResolvedValue(
      buildLocationHistory([15.31005, -4.31], [15.31065, -4.31], now),
    );
    locationHistoryService.getPassengerLocationHistory.mockResolvedValue(
      buildLocationHistory([15.31, -4.31], [15.31, -4.31], now),
    );
    bookingRepository.find.mockResolvedValue([autoBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      {
        type: 'dropoff_confirmed',
        bookingId: 'booking-1',
        tripId: 'trip-1',
        passengerId: 'passenger-1',
      },
      expect.objectContaining({
        type: 'driver_arrived_destination',
        tripId: 'trip-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
      }),
    ]);
    expect(bookingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        droppedOff: true,
        pickedUpConfirmedByPassenger: true,
        passengerDestinationApproachNotifiedAt: expect.any(Date),
        droppedOffConfirmedByPassenger: true,
        status: BookingStatus.COMPLETED,
      }),
    );
    expect(finalizeCompletedBookingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking-1' }),
    );
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.COMPLETED,
        completedAt: expect.any(Date),
        destinationApproachNotifiedAt: expect.any(Date),
        destinationReachedAt: expect.any(Date),
      }),
    );
  });

  it('completes the trip when the driver is within 25 meters of the destination', async () => {
    const now = new Date();
    const completedBooking = {
      ...booking,
      status: BookingStatus.COMPLETED,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: true,
      droppedOffConfirmedByPassenger: true,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: {
        type: 'Point',
        coordinates: [15.3101, -4.31],
      },
      passengerLastLocationUpdateAt: now,
      trip: {
        ...booking.trip,
        id: 'trip-1',
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.31015, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
        destinationApproachNotifiedAt: null,
        destinationReachedAt: null,
      },
    };
    bookingRepository.find.mockResolvedValue([completedBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'driver_arrived_destination',
        tripId: 'trip-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
      }),
    ]);
    expect(bookingRepository.save).not.toHaveBeenCalled();
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.COMPLETED,
        destinationApproachNotifiedAt: expect.any(Date),
        destinationReachedAt: expect.any(Date),
        completedAt: expect.any(Date),
      }),
    );
  });

  it('does not complete the trip after approach if the final destination was not reached', async () => {
    const now = new Date();
    const approachNotifiedAt = new Date(now.getTime() - 5 * 60 * 1000 - 1000);
    const completedBooking = {
      ...booking,
      status: BookingStatus.COMPLETED,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: true,
      droppedOffConfirmedByPassenger: true,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: null,
      passengerLastLocationUpdateAt: null,
      trip: {
        ...booking.trip,
        id: 'trip-1',
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.3103, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
        destinationApproachNotifiedAt: approachNotifiedAt,
        destinationReachedAt: null,
      },
    };
    bookingRepository.find.mockResolvedValue([completedBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([]);
    expect(bookingRepository.save).not.toHaveBeenCalled();
    expect(tripRepository.save).not.toHaveBeenCalled();
  });

  it('automatically completes the trip when reaching the final destination', async () => {
    const now = new Date();
    const completedBooking = {
      ...booking,
      status: BookingStatus.COMPLETED,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: true,
      droppedOffConfirmedByPassenger: true,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: null,
      passengerLastLocationUpdateAt: null,
      trip: {
        ...booking.trip,
        id: 'trip-1',
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.31005, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
        destinationApproachNotifiedAt: null,
        destinationReachedAt: null,
      },
    };
    bookingRepository.find.mockResolvedValue([completedBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'driver_arrived_destination',
        tripId: 'trip-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
      }),
    ]);
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.COMPLETED,
        completedAt: expect.any(Date),
      }),
    );
  });

  it('automatically completes the trip after the final destination zone is passed', async () => {
    const now = new Date();
    const completedBooking = {
      ...booking,
      status: BookingStatus.COMPLETED,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: true,
      droppedOffConfirmedByPassenger: true,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      passengerCurrentLocation: null,
      passengerLastLocationUpdateAt: null,
      trip: {
        ...booking.trip,
        id: 'trip-1',
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.3104, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
        destinationApproachNotifiedAt: now,
        destinationReachedAt: now,
      },
    };
    bookingRepository.find.mockResolvedValue([completedBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'driver_arrived_destination',
        tripId: 'trip-1',
        distanceMeters: expect.any(Number),
        detectedAt: expect.any(String),
      }),
    ]);
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.COMPLETED,
        completedAt: expect.any(Date),
      }),
    );
  });

  it('does not emit a trip destination event while an accepted booking is not dropped off', async () => {
    const now = new Date();
    const unfinishedBooking = {
      ...booking,
      status: BookingStatus.ACCEPTED,
      paymentMode: TripPaymentMode.CASH,
      paymentStatus: BookingPaymentStatus.NOT_REQUIRED,
      pickedUp: true,
      pickedUpConfirmedByPassenger: true,
      droppedOff: false,
      droppedOffConfirmedByPassenger: false,
      passengerDestinationPoint: { type: 'Point', coordinates: [15.2, -4.2] },
      passengerCurrentLocation: {
        type: 'Point',
        coordinates: [15.2, -4.2],
      },
      passengerLastLocationUpdateAt: now,
      trip: {
        ...booking.trip,
        id: 'trip-1',
        status: TripStatus.ACTIVE,
        driverId: 'driver-1',
        currentLocation: { type: 'Point', coordinates: [15.3101, -4.31] },
        lastLocationUpdateAt: now,
        arrivalPoint: { type: 'Point', coordinates: [15.31, -4.31] },
      },
    };
    bookingRepository.find.mockResolvedValue([unfinishedBooking]);

    const result = await service.evaluateAutomaticRideProgressForTrip('trip-1');

    expect(result.events).toEqual([]);
    expect(bookingRepository.save).not.toHaveBeenCalled();
    expect(tripRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TripStatus.ACTIVE,
        destinationApproachNotifiedAt: expect.any(Date),
      }),
    );
  });
});
