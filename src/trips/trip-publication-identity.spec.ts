import { TripsService } from './trips.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { TripStatus } from './entities/trip.entity';
import { RecurringTripTemplateStatus } from './entities/recurring-trip-template.entity';

// Real service + real publication guard; repository I/O only is simulated here.
function fixture() {
  const identity = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 'latest', status: KycStatus.APPROVED }),
  };
  const driver = {
    id: 'driver',
    role: UserRole.DRIVER,
    isActive: true,
    status: UserStatus.ACTIVE,
    profilePicture: 'test.jpg',
    hasPublishedTrip: true,
    vehicles: [{ isActive: true }],
  };
  const users = {
    findOne: jest.fn().mockResolvedValue(driver),
    update: jest.fn(),
  };
  const trips = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    manager: {} as any,
  };
  trips.manager.transaction = jest.fn(async (_isolation, work) =>
    work({
      query: jest.fn().mockResolvedValue([{ busy: false }]),
      getRepository: (entity) =>
        entity === User ? users : entity === KycDocument ? identity : trips,
    }),
  );
  const cursor = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const template = {
    id: 'template',
    driverId: driver.id,
    vehicleId: 'vehicle',
    vehicle: { id: 'vehicle', isActive: true, type: 'car' },
    status: RecurringTripTemplateStatus.ACTIVE,
    startDate: '2030-01-02',
    endDate: '2030-01-02',
    lastGeneratedDate: null,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    departureTimeMinutes: 720,
    totalSeats: 2,
    pricePerSeat: 3000,
    acceptedPaymentModes: ['cash'],
  };
  const templates = {
    find: jest.fn().mockResolvedValue([template]),
    createQueryBuilder: jest.fn(() => cursor),
  };
  const service: any = Object.assign(Object.create(TripsService.prototype), {
    tripRepository: trips,
    userRepository: users,
    kycDocumentRepository: identity,
    recurringTripTemplateRepository: templates,
    tripRequestRepository: {
      findOne: jest.fn().mockResolvedValue({ passengerId: 'passenger' }),
    },
    cacheService: { del: jest.fn() },
    logger: { log: jest.fn(), debug: jest.fn(), error: jest.fn() },
    RECURRING_GENERATION_WINDOW_DAYS: 14,
    applyDailyTripPublicationQuota: jest.fn(async (_driverId, items) => items),
    invalidateTripCaches: jest.fn(),
    findOne: jest.fn().mockResolvedValue({ id: 'result' }),
  });
  return { service, identity, trips, templates, template, cursor };
}

describe('KYC on recurring and private-to-public publication', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it.each([null, KycStatus.PENDING, KycStatus.REJECTED])(
    'cron does not publish or advance its cursor with latest KYC %s',
    async (status) => {
      const f = fixture();
      f.identity.findOne.mockResolvedValue(
        status === null ? null : { id: 'latest', status },
      );
      await f.service.generateRecurringTrips();
      expect(f.trips.create).toHaveBeenCalled(); // reaches the real recurring publication path
      expect(f.trips.save).not.toHaveBeenCalled();
      expect(f.cursor.execute).not.toHaveBeenCalled();
      expect(f.template.lastGeneratedDate).toBeNull();
      expect(f.service.invalidateTripCaches).not.toHaveBeenCalled();
      expect(f.service.logger.error).toHaveBeenCalled();
      expect(f.template.status).toBe(RecurringTripTemplateStatus.ACTIVE);
      // Approval later can resume the same schedule without silently losing days.
      f.identity.findOne.mockResolvedValue({
        id: 'latest',
        status: KycStatus.APPROVED,
      });
      await f.service.generateRecurringTrips();
      expect(f.trips.save).toHaveBeenCalledTimes(1);
      expect(f.cursor.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, KycStatus.PENDING, KycStatus.REJECTED])(
    'private-to-public rejects latest KYC %s before saving',
    async (status) => {
      const f = fixture();
      f.trips.findOne.mockResolvedValue({
        id: 'trip',
        driverId: 'driver',
        isPrivate: true,
        tripRequestId: 'request',
        status: TripStatus.PENDING,
      });
      f.identity.findOne.mockResolvedValue(
        status === null ? null : { id: 'latest', status },
      );
      await expect(
        f.service.makeTripPublic('trip', 'passenger'),
      ).rejects.toMatchObject({
        response: { code: 'DRIVER_KYC_NOT_APPROVED' },
      });
      expect(f.identity.findOne).toHaveBeenCalledWith({
        where: { userId: 'driver' },
        order: { createdAt: 'DESC', id: 'DESC' },
        select: ['id', 'status'],
      });
      expect(f.trips.save).not.toHaveBeenCalled();
      expect(f.service.cacheService.del).not.toHaveBeenCalled();
    },
  );

  it('rechecks approval inside the publication transaction after the initial validation', async () => {
    const f = fixture();
    f.trips.findOne.mockResolvedValue({
      id: 'trip',
      driverId: 'driver',
      isPrivate: true,
      tripRequestId: 'request',
      status: TripStatus.PENDING,
    });
    f.identity.findOne
      .mockResolvedValueOnce({ id: 'latest', status: KycStatus.APPROVED })
      .mockResolvedValueOnce({ id: 'latest', status: KycStatus.REJECTED });
    await expect(
      f.service.makeTripPublic('trip', 'passenger'),
    ).rejects.toMatchObject({ response: { code: 'DRIVER_KYC_NOT_APPROVED' } });
    expect(f.identity.findOne).toHaveBeenCalledTimes(2);
    expect(f.trips.save).not.toHaveBeenCalled();
  });

  it('approved drivers keep passenger-authorized publication; other passengers cannot authorize it', async () => {
    const f = fixture();
    f.trips.findOne.mockResolvedValue({
      id: 'trip',
      driverId: 'driver',
      isPrivate: true,
      tripRequestId: 'request',
      status: TripStatus.PENDING,
    });
    await expect(
      f.service.makeTripPublic('trip', 'other-passenger'),
    ).rejects.toMatchObject({
      response: { code: 'TRIP_PUBLICATION_NOT_ALLOWED' },
    });
    expect(f.trips.save).not.toHaveBeenCalled();
    await expect(
      f.service.makeTripPublic('trip', 'passenger'),
    ).resolves.toEqual({ id: 'result' });
    expect(f.trips.save).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'trip', isPrivate: false }),
    ]);
  });
});
