import 'reflect-metadata';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { TripRequestsService } from './trip-requests.service';
import { TripRequestStatus } from './entities/trip-request.entity';
import { DriverOfferStatus } from './entities/driver-offer.entity';
import { FindOperator, LessThanOrEqual } from 'typeorm';

type ServiceDependencies = ConstructorParameters<typeof TripRequestsService>;

const buildService = () => {
  const repository = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const notifications = {
    sendNotificationToUser: jest.fn().mockResolvedValue(true),
  };
  const service = new TripRequestsService(
    repository as unknown as ServiceDependencies[0],
    {} as ServiceDependencies[1],
    {} as ServiceDependencies[2],
    {} as ServiceDependencies[3],
    {} as ServiceDependencies[4],
    notifications as unknown as ServiceDependencies[5],
    {} as ServiceDependencies[6],
    {} as ServiceDependencies[7],
    {} as ServiceDependencies[8],
    {} as ServiceDependencies[9],
    {} as ServiceDependencies[10],
    {} as ServiceDependencies[11],
  );
  return { service, repository, notifications };
};

describe('Trip request expiration scheduling', () => {
  afterEach(() => jest.useRealTimers());

  it('checks every thirty seconds without overlapping runs on one instance', () => {
    expect(
      Reflect.getMetadata(
        SCHEDULE_CRON_OPTIONS,
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Read decorator metadata, never invoke the unbound method.
        TripRequestsService.prototype.markExpiredTripRequests,
      ),
    ).toMatchObject({ cronTime: '*/30 * * * * *', waitForCompletion: true });
  });

  it('expires unaccepted requests at thirty seconds and accepted requests at two hours', async () => {
    const now = new Date('2026-09-12T22:00:00.000Z');
    jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
    const { service, repository, notifications } = buildService();
    const request = (id: string, extra = {}) => ({
      id,
      passengerId: 'passenger',
      status: TripRequestStatus.PENDING,
      departureDateMax: new Date(now.getTime() - 30_000),
      driverOffers: [],
      ...extra,
    });
    const candidates = [
      request('pending'),
      request('offers', { status: TripRequestStatus.OFFERS_RECEIVED }),
      request('future', {
        departureDateMax: new Date(now.getTime() - 30_000 + 1),
      }),
      request('accepted', {
        driverOffers: [{ status: DriverOfferStatus.ACCEPTED }],
      }),
      request('selected', { selectedDriverId: 'driver' }),
      request('trip', { tripId: 'trip' }),
      request('assigned', { status: TripRequestStatus.DRIVER_SELECTED }),
      request('accepted-expired', {
        status: TripRequestStatus.DRIVER_SELECTED,
        selectedDriverId: 'driver',
        tripId: 'ongoing-trip',
        departureDateMax: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        selectedAt: new Date(now.getTime() - 1000),
      }),
      request('cancelled', { status: TripRequestStatus.CANCELLED }),
    ];
    repository.find.mockResolvedValue(candidates);
    await service.markExpiredTripRequests();
    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          departureDateMax: LessThanOrEqual(
            new Date('2026-09-12T21:59:30.000Z'),
          ),
        }) as unknown,
      }),
    );
    expect(repository.update).toHaveBeenCalledTimes(3);
    expect(
      candidates
        .filter((row) => row.status === TripRequestStatus.EXPIRED)
        .map((row) => row.id),
    ).toEqual(['pending', 'offers', 'accepted-expired']);
    expect(repository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'accepted-expired',
        selectedDriverId: 'driver',
        tripId: 'ongoing-trip',
      }),
      { status: TripRequestStatus.EXPIRED },
    );
    expect(notifications.sendNotificationToUser).toHaveBeenCalledTimes(2);
    await service.markExpiredTripRequests();
    expect(repository.update).toHaveBeenCalledTimes(3);
    expect(notifications.sendNotificationToUser).toHaveBeenCalledTimes(2);
  });

  it('preserves accepted requests up to the last millisecond of the two-hour grace period', async () => {
    const now = new Date('2026-09-12T22:00:00.000Z');
    jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
    const { service, repository, notifications } = buildService();
    const request = {
      id: 'accepted-limit',
      status: TripRequestStatus.DRIVER_SELECTED,
      selectedDriverId: 'driver',
      tripId: 'trip',
      departureDateMax: new Date(now.getTime() - 2 * 60 * 60 * 1000 + 1),
      selectedAt: new Date(now.getTime() - 100),
      driverOffers: [],
    };
    repository.find.mockResolvedValue([request]);
    await service.markExpiredTripRequests();
    expect(repository.update).not.toHaveBeenCalled();
    jest.setSystemTime(new Date(now.getTime() + 1));
    await service.markExpiredTripRequests();
    expect(request.status).toBe(TripRequestStatus.EXPIRED);
    expect(request.tripId).toBe('trip');
    expect(request.selectedDriverId).toBe('driver');
    expect(notifications.sendNotificationToUser).not.toHaveBeenCalled();
  });

  it('keeps expired accepted request details private even without an accepted offer record', async () => {
    const { service, repository } = buildService();
    repository.findOne.mockResolvedValue({
      id: 'private',
      status: TripRequestStatus.DRIVER_SELECTED,
      passengerId: 'passenger',
      selectedDriverId: 'driver',
      tripId: 'trip',
      departureDateMax: new Date('2020-01-01T00:00:00.000Z'),
      driverOffers: [],
    });
    await expect(service.findOne('private', 'other-user')).rejects.toThrow(
      'Demande de trajet non trouvée',
    );
    await expect(service.findOne('private')).rejects.toThrow(
      'Demande de trajet non trouvée',
    );
  });

  it('checks the accepted deadline before creating a trip, without waiting for the cron', async () => {
    const { service, repository, notifications } = buildService();
    repository.findOne.mockResolvedValue({
      id: 'late-start',
      status: TripRequestStatus.DRIVER_SELECTED,
      passengerId: 'passenger',
      selectedDriverId: 'driver',
      tripId: null,
      departureDateMax: new Date('2020-01-01T00:00:00.000Z'),
      driverOffers: [],
    });
    await expect(
      service.startTripFromRequest('late-start', 'driver'),
    ).rejects.toThrow('Cette demande a expiré');
    expect(notifications.sendNotificationToUser).not.toHaveBeenCalled();
  });

  it('retains snapshot checks using the millisecond precision actually returned by the pg driver', async () => {
    const { service, repository } = buildService();
    const request = {
      id: 'snapshot',
      status: TripRequestStatus.PENDING,
      selectedDriverId: null,
      tripId: null,
      driverOffers: [],
      departureDateMax: new Date('2020-01-01T00:00:00.000Z'),
      updatedAt: new Date('2020-01-01T00:00:00.123Z'),
    };
    repository.find.mockResolvedValue([request]);
    await service.markExpiredTripRequests();
    const [where] = repository.update.mock.calls[0] as [
      {
        updatedAt: FindOperator<Date>;
        departureDateMax: Date;
        status: TripRequestStatus;
      },
    ];
    expect(where.departureDateMax).toEqual(request.departureDateMax);
    expect(where.status).toBe(TripRequestStatus.PENDING);
    expect(where.updatedAt.getSql?.('"updatedAt"')).toBe(
      `date_trunc('milliseconds', "updatedAt") = :expirationSnapshotUpdatedAt`,
    );
    expect(where.updatedAt.objectLiteralParameters).toEqual({
      expirationSnapshotUpdatedAt: request.updatedAt,
    });
  });

  it('keeps the cron promise pending until repository work completes', async () => {
    const { service, repository } = buildService();
    let resolveFind!: (value: unknown[]) => void;
    repository.find.mockReturnValue(
      new Promise((resolve) => {
        resolveFind = resolve;
      }),
    );
    let completed = false;
    const run = service.markExpiredTripRequests().then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(repository.find).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    resolveFind([]);
    await run;
    expect(completed).toBe(true);
  });

  it('propagates asynchronous errors to the Nest scheduler instead of a detached callback', async () => {
    const { service, repository } = buildService();
    repository.find.mockRejectedValue(new Error('repository unavailable'));
    await expect(service.markExpiredTripRequests()).rejects.toThrow(
      'repository unavailable',
    );
  });

  it('does not notify or expire when a concurrent acceptance wins the conditional update', async () => {
    const { service, repository, notifications } = buildService();
    const request = {
      id: 'concurrent',
      passengerId: 'passenger',
      status: TripRequestStatus.PENDING,
      departureDateMax: new Date('2020-01-01T00:00:00.000Z'),
      driverOffers: [],
    };
    repository.find.mockResolvedValue([request]);
    repository.update.mockResolvedValue({ affected: 0 });
    await service.markExpiredTripRequests();
    expect(request.status).toBe(TripRequestStatus.PENDING);
    expect(notifications.sendNotificationToUser).not.toHaveBeenCalled();
  });
});
