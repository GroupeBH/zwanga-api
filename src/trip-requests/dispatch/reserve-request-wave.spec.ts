import { reserveRequestWave } from './reserve-request-wave';
import { lockQueuedCandidates } from './sequential-candidates';
import type { TripRequest } from '../entities/trip-request.entity';

jest.mock('./sequential-candidates', () => ({ lockQueuedCandidates: jest.fn() }));
const lock = jest.mocked(lockQueuedCandidates);
describe('bounded request wave reservation', () => {
  const candidate = (driverId: string) => ({ driverId, candidate: { driverId, vehicleId: 'v-' + driverId, seats: 4, existingTripId: null } });
  const request = { id: 'request', immediateDispatch: true, departureDateMax: new Date(Date.now() + 60_000) } as TripRequest;
  const manager = () => ({ query: jest.fn(async (sql: string, params: unknown[]) => {
    if (!sql.startsWith('INSERT')) return [];
    return JSON.parse(params[0] as string).map(row => ({ ...row, expiresAt: new Date(Date.now() + 20_000) }));
  }) });
  beforeEach(() => jest.resetAllMocks());

  it('validates four together and batches actual deadlines with presence after insertion', async () => {
    lock.mockResolvedValue(['a', 'b', 'c', 'd'].map(candidate));
    const db = manager();
    const result = await reserveRequestWave(db as never, request, ['a', 'b', 'c', 'd'], 4);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith(db, request, ['a', 'b', 'c', 'd'], 4);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(result.map(r => r.waveSlot)).toEqual([1, 2, 3, 4]);
    expect(db.query.mock.calls[1][0]).toContain('WITH deadlines');
    expect(db.query.mock.calls[1][1][0]).toEqual(result.map(r => r.offerId));
    expect(JSON.parse(db.query.mock.calls[1][1][1] as string)).toHaveLength(4);
  });

  it('reuses the actual free slot after a partial conflict, without notifying the losing candidate', async () => {
    lock.mockResolvedValueOnce(['a', 'b', 'c', 'd'].map(candidate)).mockResolvedValueOnce([candidate('e')]);
    const db = manager();
    db.query.mockImplementationOnce(async (_sql, params) => JSON.parse(params[0] as string)
      .filter(row => row.waveSlot !== 2).map(row => ({ ...row, expiresAt: new Date() })));
    const result = await reserveRequestWave(db as never, request, ['a', 'b', 'c', 'd', 'e'], 4);
    expect(lock.mock.calls[1].slice(2)).toEqual([['e'], 1]);
    expect(result.map(r => [r.candidate.driverId, r.waveSlot])).toEqual([['a', 1], ['c', 3], ['d', 4], ['e', 2]]);
    expect(JSON.parse(db.query.mock.calls[1][1][0] as string)[0].waveSlot).toBe(2);
  });

  it('bounds rejected cached candidates to the original 32 checks and never writes for them', async () => {
    lock.mockImplementation(async (_manager, _request, ids, limit) => ids.slice(0, limit).map(driverId => ({ driverId, candidate: null })));
    const db = manager();
    expect(await reserveRequestWave(db as never, request, Array.from({ length: 50 }, (_, i) => String(i)), 4)).toEqual([]);
    expect(lock).toHaveBeenCalledTimes(8);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('preserves the one-driver target and leaves shared-trip presence unchanged', async () => {
    lock.mockResolvedValue([{ ...candidate('a'), candidate: { ...candidate('a').candidate, existingTripId: 'trip' } }]);
    const db = manager();
    await reserveRequestWave(db as never, { ...request, targetDriverId: 'a' } as TripRequest, ['a'], 4);
    expect(lock.mock.calls[0][3]).toBe(1);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('keeps the first Redis occurrence and restores queue order even if INSERT returns unordered rows', async () => {
    lock.mockResolvedValue(['a', 'b', 'c'].map(candidate));
    const db = manager();
    db.query.mockImplementationOnce(async (_sql, params) => JSON.parse(params[0] as string).reverse()
      .map(row => ({ ...row, expiresAt: new Date() })));
    const result = await reserveRequestWave(db as never, request, ['a', 'b', 'a', 'c'], 4);
    expect(result.map(row => row.candidate.driverId)).toEqual(['a', 'b', 'c']);
  });

  it('propagates SQL errors so the business transaction can roll back all offers', async () => {
    lock.mockResolvedValue([candidate('a')]);
    const db = manager();
    db.query.mockRejectedValueOnce(new Error('write failed'));
    await expect(reserveRequestWave(db as never, request, ['a'], 4)).rejects.toThrow('write failed');
  });
});
