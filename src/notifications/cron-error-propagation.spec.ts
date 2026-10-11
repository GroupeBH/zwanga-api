import { TripAvailabilityNotificationService } from './trip-availability-notification.service';
import { TripsService } from '../trips/trips.service';
import { TripRequestsService } from '../trip-requests/trip-requests.service';

describe('Scheduled jobs expose their asynchronous failures to Nest', () => {
  it.each([
    [
      TripAvailabilityNotificationService,
      'sendRecommendationNotifications',
      'userRepository',
    ],
    [TripsService, 'notifyAboutUpcomingTripDeparture', 'tripRepository'],
    [TripsService, 'notifyAboutUpcomingTripExpiration', 'tripRepository'],
    [
      TripRequestsService,
      'notifyAboutUpcomingTripRequestExpiration',
      'tripRequestRepository',
    ],
  ] as const)(
    '%s.%s awaits the database operation',
    async (type, method, repository) => {
      const service = Object.create(type.prototype);
      service.logger = { debug: jest.fn(), log: jest.fn() };
      service[repository] = {
        find: jest
          .fn()
          .mockRejectedValue(new Error('synthetic database outage')),
      };
      await expect(service[method]()).rejects.toThrow(
        'synthetic database outage',
      );
    },
  );
});
