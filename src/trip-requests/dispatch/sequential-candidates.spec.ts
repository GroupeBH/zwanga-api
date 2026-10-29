import { lockNextQueuedCandidate, sequentialCandidates } from './sequential-candidates';
import { TripRequest } from '../entities/trip-request.entity';

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

  it('invites recently located drivers first without excluding older durable positions', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await sequentialCandidates(manager as never, request);
    const [sql] = manager.query.mock.calls[0];
    expect(sql).toContain(`p."updatedAt" < now() - interval '30 minutes') AS "stalePosition"`);
    expect(sql).toContain('ORDER BY e."stalePosition", ST_Distance(');
    // Ranking only: old ongoing GPS must not masquerade as a fresh position.
    expect(sql.match(/"stalePosition"/g)).toHaveLength(2);
    expect(sql).not.toMatch(/t\.id, \(CASE[\s\S]*?END\), false/);
    expect(sql).toContain('THEN t."lastLocationUpdateAt"');
  });

  it('keeps the queued validation independent from freshness ranking', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await lockNextQueuedCandidate(manager as never, request, ['driver']);
    const [sql] = manager.query.mock.calls[0];
    expect(sql).not.toContain('ORDER BY e."stalePosition"');
    expect(sql).toContain('ORDER BY e."existingTripId" LIMIT 1');
  });

  it('checks only one Redis ID without re-ranking; mutable restrictions and the driver lock remain', async () => {
    const candidate = { driverId: 'driver', vehicleId: 'vehicle', seats: 4, existingTripId: null };
    const manager = { query: jest.fn().mockResolvedValue([candidate]) };
    expect(await lockNextQueuedCandidate(manager as never, request, ['driver', 'next'])).toEqual({ driverId: 'driver', candidate });
    const [sql, params] = manager.query.mock.calls[0];
    expect(params.at(-1)).toEqual(['driver', 'next']);
    expect(sql).toContain('queued_driver AS MATERIALIZED');
    expect(sql).toContain('p."driverId" = (SELECT id FROM queued_driver)');
    expect(sql).toContain('t."driverId" = (SELECT id FROM queued_driver)');
    expect(sql).not.toContain('ST_Distance(');
    expect(sql).not.toContain('array_position(');
    expect(sql).toContain('ST_DWithin(');
    expect(sql).toContain('kyc_documents');
    expect(sql).toContain('"isActive" = true');
    expect(sql).toContain("o.status = 'pending'");
    expect(sql).toContain('LIMIT 1 FOR NO KEY UPDATE OF driver SKIP LOCKED');
  });

  it('returns an ineligible checked ID so the next candidate can be tried without discovery', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ driverId: 'driver', vehicleId: null }]) };
    expect(await lockNextQueuedCandidate(manager as never, request, ['driver'])).toEqual({ driverId: 'driver', candidate: null });
    manager.query.mockResolvedValue([]);
    expect(await lockNextQueuedCandidate(manager as never, request, ['driver'])).toBeNull();
  });
});
