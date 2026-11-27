import { readDriverTrackingTrip, readPassengerTrackingBooking } from './read-tracking-location';

describe('batched fresh GPS projections', () => {
  it('uses one bounded driver query per burst with isolated mutable objects', async () => {
    const now = new Date();
    const db = { query: jest.fn().mockImplementation(async (_sql: string, [ids]: string[][]) => ids.map(id => ({ id,
      driverId: 'driver', lastLocationUpdateAt: now, currentLocation: { coordinates: [1, 2] } }))) };
    const [first, duplicate, other] = await Promise.all([
      readDriverTrackingTrip(db, 'a'), readDriverTrackingTrip(db, 'a'), readDriverTrackingTrip(db, 'b'),
    ]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual([['a', 'b']]);
    first!.currentLocation!.coordinates[0] = 9;
    first!.lastLocationUpdateAt!.setTime(0);
    expect(duplicate!.currentLocation!.coordinates).toEqual([1, 2]);
    expect(duplicate!.lastLocationUpdateAt).toEqual(now);
    expect(other!.id).toBe('b');
  });

  it('never gives another caller the row of an authorized passenger in the same batch', async () => {
    const row = { id: 'booking', passengerId: 'owner', trip: { status: 'ongoing' } };
    const db = { query: jest.fn().mockResolvedValue([row]) };
    const [owner, stranger, duplicate] = await Promise.all([
      readPassengerTrackingBooking(db, 'booking', 'owner'),
      readPassengerTrackingBooking(db, 'booking', 'stranger'),
      readPassengerTrackingBooking(db, 'booking', 'owner'),
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining(
      '(b.id, b."passengerId") IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))'),
    [['booking', 'booking', 'booking'], ['owner', 'stranger', 'owner']]);
    expect(stranger).toBeNull();
    owner!.trip.status = 'completed' as any;
    expect(duplicate!.trip.status).toBe('ongoing');
    db.query.mockResolvedValue([]);
    expect(await readPassengerTrackingBooking(db, 'booking', 'owner')).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('caps GPS batches at 32 reads, including duplicate inputs', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    expect(await Promise.all(Array.from({ length: 70 }, () => readDriverTrackingTrip(db, 'missing'))))
      .toEqual(Array(70).fill(null));
    expect(db.query).toHaveBeenCalledTimes(3);
  });
});
