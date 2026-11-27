import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Trip } from './entities/trip.entity';
import { TripCoPassengersService } from './trip-co-passengers.service';

describe('Trip co-passengers restricted projection', () => {
  function fixture(rows: unknown[] = []) {
    const query = Object.fromEntries(
      [
        'leftJoin',
        'select',
        'addSelect',
        'where',
        'andWhere',
        'setParameters',
        'orderBy',
        'addOrderBy',
      ].map((method) => [method, jest.fn().mockReturnThis()]),
    );
    query.getRawMany = jest.fn().mockResolvedValue(rows);
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    return {
      query,
      repository,
      service: new TripCoPassengersService(
        repository as unknown as Repository<Trip>,
      ),
    };
  }
  it('denies an empty authenticated identity before any read', async () => {
    const { service, repository } = fixture();
    await expect(service.list('trip', '')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });
  it('denies a missing or unauthorized trip with the same response', async () => {
    const { service } = fixture();
    await expect(service.list('trip', 'outsider')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('uses fresh membership and only published non-private trips in the same query', async () => {
    const { service, query } = fixture([{ tripId: 'trip', id: null }]);
    expect(await service.list('trip', 'viewer')).toEqual({
      tripId: 'trip',
      participants: [],
    });
    expect(query.leftJoin).toHaveBeenCalledWith(
      'trip.bookings',
      'membership',
      'membership.passengerId = :viewerId AND membership.status IN (:...confirmed)',
    );
    expect(query.leftJoin).toHaveBeenCalledWith(
      'trip.bookings',
      'fellow',
      'fellow.passengerId != :viewerId AND fellow.status IN (:...confirmed)',
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      '(membership.id IS NOT NULL OR trip.driverId = :viewerId)',
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      'trip.isPrivate = false AND trip.tripRequestId IS NULL',
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      'trip.status IN (:...tripStatuses)',
      { tripStatuses: ['upcoming', 'ongoing', 'completed'] },
    );
    expect(query.setParameters).toHaveBeenCalledWith({
      viewerId: 'viewer',
      confirmed: ['accepted', 'completed'],
    });
    expect(query.getRawMany).toHaveBeenCalledTimes(1);
  });
  it('selects a strict allowlist, never full profiles or bookings', async () => {
    const { service, query } = fixture([{ tripId: 'trip', id: null }]);
    await service.list('trip', 'viewer');
    expect(query.select.mock.calls).toEqual([['trip.id', 'tripId']]);
    expect(query.addSelect.mock.calls).toEqual([
      ['fellow.id', 'id'],
      ['profile.id', 'userId'],
      ['profile.firstName', 'firstName'],
      ['profile.profilePicture', 'avatarUrl'],
      ['fellow.numberOfSeats', 'seats'],
    ]);
  });
  it('deduplicates reservation rows and never serializes accidental private columns', async () => {
    const row = {
      tripId: 'trip',
      id: 'reservation',
      userId: 'public-member-id',
      firstName: ' Exemple ',
      avatarUrl: null,
      seats: 2,
      phone: 'private',
      email: 'private',
      lastName: 'private',
      passengerId: 'private',
      paymentAmount: 99,
      currentLocation: 'private',
    };
    const { service } = fixture([
      row,
      row,
      {
        tripId: 'trip',
        id: 'fallback',
        firstName: null,
        avatarUrl: null,
        seats: null,
      },
    ]);
    expect(await service.list('trip', 'viewer')).toEqual({
      tripId: 'trip',
      participants: [
        {
          id: 'reservation',
          userId: 'public-member-id',
          firstName: 'Exemple',
          avatarUrl: null,
          seats: 2,
        },
        {
          id: 'fallback',
          userId: null,
          firstName: 'Passager',
          avatarUrl: null,
          seats: 1,
        },
      ],
    });
  });
});
