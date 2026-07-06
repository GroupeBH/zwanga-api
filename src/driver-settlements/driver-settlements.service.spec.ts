import { BookingPaymentStatus, BookingStatus } from '../bookings/entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';
import { TripPaymentMode } from '../payments/enums/trip-payment-mode.enum';
import { DriverSettlementsService } from './driver-settlements.service';
import { DriverEarningStatus } from './entities/driver-earning.entity';

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

    service = new DriverSettlementsService(
      earningRepository as any,
      payoutRepository as any,
      {} as any,
      configService as any,
      {} as any,
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
});
