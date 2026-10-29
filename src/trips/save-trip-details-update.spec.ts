import { Repository } from 'typeorm';
import { Trip, TripStatus } from './entities/trip.entity';
import { saveTripDetailsUpdate } from './save-trip-details-update';

describe('save trip details with schedule policy', () => {
  const hour = (n: number) => new Date(Date.UTC(2030, 0, 1, n));
  const fixture = () => {
    const before = {
      id: '00000000-0000-4000-8000-000000000001',
      driverId: 'driver',
      tripRequestId: null,
      isPrivate: false,
      status: TripStatus.PENDING,
      departureDate: hour(8),
      estimatedArrivalDate: hour(9),
      description: 'Before',
      totalSeats: 4,
      availableSeats: 3,
    } as Trip;
    const current = { ...before };
    const trips = {
      findOne: jest.fn(async () => ({ ...current })),
      save: jest.fn(async (value) => value),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([{ busy: false }]),
      getRepository: () => trips,
    };
    const transaction = jest.fn(async (_isolation, work) => work(manager));
    const repository = {
      manager: { transaction },
    } as unknown as Repository<Trip>;
    return { before, current, trips, manager, transaction, repository };
  };

  it('locks owner before trip and rechecks under READ COMMITTED, preserving the travel duration', async () => {
    const f = fixture();
    const saved = await saveTripDetailsUpdate(f.repository, f.before, {
      ...f.before,
      departureDate: hour(12),
    });
    expect(f.transaction).toHaveBeenCalledWith(
      'READ COMMITTED',
      expect.any(Function),
    );
    expect(f.manager.query.mock.calls[0][0]).toContain('FOR NO KEY UPDATE');
    expect(f.manager.query.mock.invocationCallOrder[0]).toBeLessThan(
      f.trips.findOne.mock.invocationCallOrder[0],
    );
    expect(f.trips.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'for_no_key_update' } }),
    );
    expect(saved.estimatedArrivalDate).toEqual(hour(13));
    expect(f.manager.query.mock.calls[1][1]).toEqual([
      'driver',
      hour(12),
      hour(13),
      f.before.id,
      null,
    ]);
    expect(f.trips.save).toHaveBeenCalledTimes(1);
  });

  it.each([true, undefined])(
    'never saves when the schedule check is conflicting or missing (%s)',
    async (busy) => {
      const f = fixture();
      f.manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(busy === undefined ? [] : [{ busy }]);
      await expect(
        saveTripDetailsUpdate(f.repository, f.before, {
          ...f.before,
          departureDate: hour(12),
        }),
      ).rejects.toMatchObject({
        response: { code: 'DRIVER_SCHEDULE_CONFLICT' },
      });
      expect(f.trips.save).not.toHaveBeenCalled();
    },
  );

  it.each([null, new Date('2029-01-01Z')])(
    'keeps conservative unknown-duration fallback (%s)',
    async (end) => {
      const f = fixture();
      f.before.estimatedArrivalDate = end;
      f.current.estimatedArrivalDate = end;
      const saved = await saveTripDetailsUpdate(f.repository, f.before, {
        ...f.before,
        departureDate: hour(12),
      });
      expect(saved.estimatedArrivalDate).toBeNull();
    },
  );

  it('keeps the latest schedule and tracking fields during an unrelated edit', async () => {
    const f = fixture();
    f.current.departureDate = hour(12);
    f.current.estimatedArrivalDate = hour(13);
    f.current.lastLocationUpdateAt = hour(10);
    f.current.availableSeats = 2;
    const saved = await saveTripDetailsUpdate(f.repository, f.before, {
      ...f.before,
      description: 'After',
    });
    expect(saved).toMatchObject({
      departureDate: hour(12),
      estimatedArrivalDate: hour(13),
      lastLocationUpdateAt: hour(10),
      availableSeats: 2,
      description: 'After',
    });
    expect(f.manager.query).toHaveBeenCalledTimes(1); // Owner lock, no schedule change.
  });

  it.each(['status', 'departureDate', 'availableSeats'] as const)(
    'rejects stale conflicting state (%s)',
    async (field) => {
      const f = fixture();
      if (field === 'status') f.current.status = TripStatus.ACTIVE;
      if (field === 'departureDate') f.current.departureDate = hour(10);
      if (field === 'availableSeats') f.current.availableSeats = 1;
      await expect(
        saveTripDetailsUpdate(f.repository, f.before, {
          ...f.before,
          departureDate: hour(12),
          totalSeats: 5,
          availableSeats: 4,
        }),
      ).rejects.toMatchObject({ response: { code: 'TRIP_CHANGED' } });
      expect(f.trips.save).not.toHaveBeenCalled();
    },
  );

  it('excludes the own request and checks public courses too for a linked private trip', async () => {
    const f = fixture();
    f.before.isPrivate = f.current.isPrivate = true;
    f.before.tripRequestId = f.current.tripRequestId =
      '00000000-0000-4000-8000-000000000002';
    await saveTripDetailsUpdate(f.repository, f.before, {
      ...f.before,
      departureDate: hour(12),
    });
    const [sql, params] = f.manager.query.mock.calls[1];
    expect(params[4]).toBe(f.before.tripRequestId);
    expect(sql).toContain('busy_trip.id <> $4::uuid');
    expect(sql).toContain('assigned.id <> $5::uuid');
    expect(sql).not.toContain('AND (busy_trip."isPrivate" = true OR');
  });

  it('tolerates a legacy non-UUID request reference without passing it to a UUID cast', async () => {
    const f = fixture();
    f.before.tripRequestId = f.current.tripRequestId = 'legacy-reference';
    await saveTripDetailsUpdate(f.repository, f.before, {
      ...f.before,
      departureDate: hour(12),
    });
    expect(f.manager.query.mock.calls[1][1][4]).toBeNull();
  });

  it('does not save unchanged values', async () => {
    const f = fixture();
    await saveTripDetailsUpdate(f.repository, f.before, { ...f.before });
    expect(f.trips.save).not.toHaveBeenCalled();
    expect(f.manager.query).toHaveBeenCalledTimes(1);
  });

  it('also checks a trip made upcoming again without changing its date', async () => {
    const f = fixture();
    f.before.status = f.current.status = TripStatus.COMPLETED;
    f.manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ busy: true }]);
    await expect(
      saveTripDetailsUpdate(f.repository, f.before, {
        ...f.before,
        status: TripStatus.PENDING,
      }),
    ).rejects.toMatchObject({ response: { code: 'DRIVER_SCHEDULE_CONFLICT' } });
    expect(f.trips.save).not.toHaveBeenCalled();
  });

  it('does not recreate a removed trip', async () => {
    const f = fixture();
    f.trips.findOne.mockResolvedValueOnce(null as never);
    await expect(
      saveTripDetailsUpdate(f.repository, f.before, {
        ...f.before,
        description: 'After',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.trips.save).not.toHaveBeenCalled();
  });
});
