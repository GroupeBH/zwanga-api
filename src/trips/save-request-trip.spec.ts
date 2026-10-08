import { ConflictException } from '@nestjs/common';
import { saveRequestTrip } from './save-request-trip';
import { Trip } from './entities/trip.entity';
import {
  TripRequest,
  TripRequestStatus,
} from '../trip-requests/entities/trip-request.entity';

describe('Direct acceptance serializes its final trip insert with request edits', () => {
  function build() {
    const request = {
      id: 'request',
      status: TripRequestStatus.PENDING,
      selectedDriverId: null,
      tripId: null,
      updatedAt: new Date(),
      departureDateMax: new Date(Date.now() + 3600000),
    } as TripRequest;
    const requests = { findOne: jest.fn().mockResolvedValue({ ...request }) };
    const trips = {
      exists: jest.fn().mockResolvedValue(false),
      save: jest.fn(async (t) => t),
    };
    const offers = { exists: jest.fn().mockResolvedValue(false) };
    const repository = {
      manager: {
        transaction: jest.fn(async (work) =>
          work({
            getRepository: (entity: unknown) =>
              entity === TripRequest
                ? requests
                : entity === Trip
                  ? trips
                  : offers,
          }),
        ),
      },
    };
    return { request, requests, trips, offers, repository };
  }
  it('holds a write lock while saving the trip', async () => {
    const c = build();
    await saveRequestTrip(
      c.repository as any,
      { id: 'trip' } as Trip,
      c.request,
    );
    expect(c.requests.findOne).toHaveBeenCalledWith({
      where: { id: 'request' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(c.trips.save).toHaveBeenCalledTimes(1);
  });
  it.each(['edit', 'trip', 'offer', 'expired'])(
    'rejects a concurrent %s before inserting anything',
    async (kind) => {
      const c = build();
      if (kind === 'edit')
        c.requests.findOne.mockResolvedValue({
          ...c.request,
          updatedAt: new Date(c.request.updatedAt.getTime() + 1),
        });
      if (kind === 'trip') c.trips.exists.mockResolvedValue(true);
      if (kind === 'offer') c.offers.exists.mockResolvedValue(true);
      if (kind === 'expired')
        c.requests.findOne.mockResolvedValue({
          ...c.request,
          status: TripRequestStatus.EXPIRED,
        });
      await expect(
        saveRequestTrip(c.repository as any, {} as Trip, c.request),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(c.trips.save).not.toHaveBeenCalled();
    },
  );
});
