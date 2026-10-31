import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { TripRequestsController } from './trip-requests.controller';
import { TripRequestsService } from './trip-requests.service';
import { ChangeRequestDriverDto } from './dto/change-request-driver.dto';
import { changeRequestDriver } from './change-request-driver';

jest.mock('./change-request-driver', () => ({
  changeRequestDriver: jest.fn(),
}));
const change = jest.mocked(changeRequestDriver);

describe('change driver API contract and post-commit recovery', () => {
  const dto = {
    selectedDriverId: randomUUID(),
    selectedAt: new Date().toISOString(),
  };
  beforeEach(() => jest.resetAllMocks());

  it('validates the selected driver and selection timestamp', async () => {
    expect(
      await validate(Object.assign(new ChangeRequestDriverDto(), dto)),
    ).toHaveLength(0);
    expect(
      (await validate(new ChangeRequestDriverDto()))
        .map((e) => e.property)
        .sort(),
    ).toEqual(['selectedAt', 'selectedDriverId']);
    expect(
      await validate(
        Object.assign(new ChangeRequestDriverDto(), {
          ...dto,
          selectedAt: 'not-a-date',
        }),
      ),
    ).toHaveLength(1);
    expect(
      await validate(
        Object.assign(new ChangeRequestDriverDto(), {
          ...dto,
          selectedDriverId: 'invalid',
        }),
      ),
    ).toHaveLength(1);
  });

  it('gets the owner identity from authentication, never the body', async () => {
    const service = {
      changeSelectedDriver: jest.fn().mockResolvedValue({ id: 'request' }),
    };
    const controller = new TripRequestsController(
      service as unknown as TripRequestsService,
    );
    expect(
      await controller.changeSelectedDriver(
        { user: { userId: 'passenger' } },
        'request',
        dto,
      ),
    ).toEqual({ id: 'request' });
    expect(service.changeSelectedDriver).toHaveBeenCalledWith(
      'passenger',
      'request',
      dto,
    );
  });

  function setup() {
    const service = Object.assign(
      Object.create(TripRequestsService.prototype),
      {
        tripRequestRepository: { manager: {} },
        logger: { warn: jest.fn() },
        bookingsService: {
          invalidateManualRideCaches: jest.fn().mockResolvedValue(undefined),
        },
        tripsService: {
          invalidateChangedRequestTrip: jest.fn().mockResolvedValue(undefined),
        },
        driverDispatch: {
          notifyScheduledRequest: jest.fn().mockResolvedValue(true),
        },
        notificationService: {
          dispatchTransactionalNotifications: jest
            .fn()
            .mockResolvedValue(undefined),
        },
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 'request', status: 'pending' }),
      },
    );
    change.mockResolvedValue({
      changed: true,
      bookingIds: ['booking'],
      tripId: 'trip',
    });
    return service;
  }

  it('restarts dispatch only after the database commit and returns the existing request shape', async () => {
    const service = setup();
    change.mockImplementationOnce(async () => {
      expect(
        service.driverDispatch.notifyScheduledRequest,
      ).not.toHaveBeenCalled();
      expect(
        service.notificationService.dispatchTransactionalNotifications,
      ).not.toHaveBeenCalled();
      return { changed: true, bookingIds: ['booking'], tripId: 'trip' };
    });
    expect(
      await service.changeSelectedDriver('passenger', 'request', dto),
    ).toEqual({ id: 'request', status: 'pending' });
    expect(service.driverDispatch.notifyScheduledRequest).toHaveBeenCalledWith(
      'request',
    );
    expect(
      service.bookingsService.invalidateManualRideCaches,
    ).toHaveBeenCalledWith('booking');
    expect(
      service.tripsService.invalidateChangedRequestTrip,
    ).toHaveBeenCalledWith('trip');
  });

  it('does not report a failed cancellation when cache, Redis or push fail after commit', async () => {
    const service = setup();
    service.driverDispatch.notifyScheduledRequest.mockRejectedValue(
      new Error('Redis offline'),
    );
    service.bookingsService.invalidateManualRideCaches.mockRejectedValue(
      new Error('cache offline'),
    );
    service.tripsService.invalidateChangedRequestTrip.mockRejectedValue(
      new Error('cache offline'),
    );
    service.notificationService.dispatchTransactionalNotifications.mockRejectedValue(
      new Error('push offline'),
    );
    await expect(
      service.changeSelectedDriver('passenger', 'request', dto),
    ).resolves.toEqual({ id: 'request', status: 'pending' });
  });

  it('never dispatches or notifies a rolled-back driver change', async () => {
    const service = setup();
    change.mockRejectedValue(new Error('payment engaged'));
    await expect(
      service.changeSelectedDriver('passenger', 'request', dto),
    ).rejects.toThrow('payment engaged');
    expect(
      service.driverDispatch.notifyScheduledRequest,
    ).not.toHaveBeenCalled();
    expect(
      service.notificationService.dispatchTransactionalNotifications,
    ).not.toHaveBeenCalled();
  });
});
