import { lockNextQueuedCandidate, lockQueuedCandidates, sequentialCandidates } from './sequential-candidates';
import { TripRequest } from '../entities/trip-request.entity';
import { PRESENCE_ALERT_LOCATION_SQL, ONGOING_ALERT_LOCATION_SQL } from './driver-alert-location-policy';

describe('sequential discovery versus queued validation', () => {
  const request = { id: 'request', passengerId: 'passenger', vehicleType: 'car', numberOfSeats: 1,
    departurePoint: { type: 'Point', coordinates: [15.31, -4.3] }, departureDateMin: new Date(),
    paymentMode: 'cash', maxPricePerSeat: 1000 } as TripRequest;

  it('only discovery ranks the area and returns a bounded queue', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await sequentialCandidates(manager as never, request);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain('ST_Distance(');
    expect(sql).toContain('LIMIT 50');
    expect(sql).not.toContain('FOR NO KEY UPDATE');
    expect(params).toHaveLength(10);
  });

  it('invites recently located drivers first within the 48-hour window', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await sequentialCandidates(manager as never, request);
    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain(`p."updatedAt" < now() - interval '30 minutes') AS "stalePosition"`);
    expect(sql).toContain('ORDER BY e."stalePosition", ST_Distance(');
    // Ranking only: old ongoing GPS must not masquerade as a fresh position.
    expect(sql.match(/"stalePosition"/g)).toHaveLength(2);
    expect(sql).not.toMatch(/t\.id, \(CASE[\s\S]*?END\), false/);
    expect(sql).toContain('THEN t."lastLocationUpdateAt"');
    expect(sql).toContain(PRESENCE_ALERT_LOCATION_SQL);
    expect(sql).toContain(ONGOING_ALERT_LOCATION_SQL);
  });

  it('prunes occupied and already invited drivers inside both discovery branches', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await sequentialCandidates(manager as never, request);
    const [sql] = manager.query.mock.calls[0];
    const [presence, ongoing] = sql.split('UNION ALL');
    for (const [branch, driver] of [[presence, 'p'], [ongoing, 't']]) {
      expect(branch).toContain(`o."requestId" = $7 AND o."driverId" = ${driver}."driverId"`);
      expect(branch).toContain(`o."driverId" = ${driver}."driverId" AND o.status = 'pending'`);
    }
    expect(sql).not.toContain('o."driverId" = e."driverId"');
    expect(sql).toContain('ORDER BY e."stalePosition", ST_Distance(');
    expect(sql).toContain('LIMIT 50');
  });

  it('keeps the queued validation independent from freshness ranking', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await lockNextQueuedCandidate(manager as never, request, ['driver']);
    const [sql] = manager.query.mock.calls[0];
    expect(sql).not.toContain('ORDER BY e."stalePosition"');
    expect(sql).toContain('ORDER BY e."existingTripId" LIMIT 1');
    expect(sql).toContain(PRESENCE_ALERT_LOCATION_SQL);
    expect(sql).toContain(ONGOING_ALERT_LOCATION_SQL);
  });

  it('does not rejoin every user after both eligibility branches already checked the account', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await sequentialCandidates(manager as never, request);
    const [sql] = manager.query.mock.calls[0];
    expect(sql).not.toContain('FROM eligible e JOIN users');
    expect(sql.match(/EXISTS \(SELECT 1 FROM users u WHERE u.id/g)).toHaveLength(2);
    expect(sql.match(/u\."isActive" = true/g)).toHaveLength(2);
    expect(sql.match(/kyc_documents k/g)).toHaveLength(2);
    // The actual driver reservation still locks users in the queued path.
    await lockNextQueuedCandidate(manager as never, request, ['driver']);
    expect(manager.query.mock.calls[1][0]).toContain('FOR NO KEY UPDATE OF driver SKIP LOCKED');
  });

  it('checks only one Redis ID without re-ranking; mutable restrictions and the driver lock remain', async () => {
    const candidate = { driverId: 'driver', vehicleId: 'vehicle', seats: 4, existingTripId: null };
    const manager = { query: jest.fn().mockResolvedValue([candidate]) };
    expect(await lockNextQueuedCandidate(manager as never, request, ['driver', 'next'])).toEqual({ driverId: 'driver', candidate });
    const [sql, params] = manager.query.mock.calls[0];
    expect(params.slice(-2)).toEqual([['driver', 'next'], 1]);
    expect(sql).toContain('queued_driver AS MATERIALIZED');
    expect(sql).toContain('p."driverId" IN (SELECT id FROM queued_driver)');
    expect(sql).toContain('t."driverId" IN (SELECT id FROM queued_driver)');
    expect(sql).not.toContain('ST_Distance(');
    expect(sql).not.toContain('array_position(');
    expect(sql).toContain('ST_DWithin(');
    expect(sql).toContain('kyc_documents');
    expect(sql).toContain('"isActive" = true');
    expect(sql).toContain("o.status = 'pending'");
    expect(sql).toContain('LIMIT $12 FOR NO KEY UPDATE OF driver SKIP LOCKED');
  });

  it('returns an ineligible checked ID so the next candidate can be tried without discovery', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ driverId: 'driver', vehicleId: null }]) };
    expect(await lockNextQueuedCandidate(manager as never, request, ['driver'])).toEqual({ driverId: 'driver', candidate: null });
    manager.query.mockResolvedValue([]);
    expect(await lockNextQueuedCandidate(manager as never, request, ['driver'])).toBeNull();
  });

  it('bounds and deduplicates a whole wave without re-ranking or skipping eligibility checks', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await lockQueuedCandidates(manager as never, request, ['a', 'b', 'a', 'c', 'd'], 4);
    expect(manager.query.mock.calls[0][1].slice(-2)).toEqual([['a', 'b', 'c', 'd'], 4]);
    expect(manager.query.mock.calls[0][0]).toContain('ORDER BY q.position');
    for (const limit of [0, 5, 1.5, NaN])
      await expect(lockQueuedCandidates(manager as never, request, ['a'], limit)).rejects.toThrow();
    expect(manager.query).toHaveBeenCalledTimes(1);
  });
});
