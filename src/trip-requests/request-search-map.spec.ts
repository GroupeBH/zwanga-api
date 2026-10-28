import { requestSearchMap } from './request-search-map';

describe('passenger request search map', () => {
  const open = { id: 'request', passengerId: 'owner', status: 'pending', departureDateMax: new Date(Date.now() + 600000),
    departurePoint: { type: 'Point', coordinates: [15.3, -4.3] } };
  function setup(request: any = open, rows: any[] = []) {
    const findOne = jest.fn().mockResolvedValue(request), query = jest.fn().mockResolvedValue(rows);
    return { manager: { getRepository: () => ({ findOne }), query } as any, findOne, query };
  }
  it('checks ownership before reading any location', async () => {
    const { manager, findOne, query } = setup(null);
    await expect(requestSearchMap(manager, 'other', 'request')).rejects.toThrow('Commande introuvable');
    expect(findOne).toHaveBeenCalledWith({ where: { id: 'request', passengerId: 'other' } });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([{ status: 'cancelled' }, { status: 'expired' }, { selectedDriverId: 'driver' }, { tripId: 'trip' },
    { departureDateMax: new Date(Date.now() - 4 * 3600000) },
    { departureDateMax: new Date(Date.now() - 60000) }])('stops discovery for closed/assigned/overdue requests %j', async patch => {
    const { manager, query } = setup({ ...open, ...patch });
    expect(await requestSearchMap(manager, 'owner', 'request')).toMatchObject({ searching: false, groups: [], total: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the dispatch deadline exactly, without expiring or deleting the editable request', async () => {
    jest.useFakeTimers();
    try {
      const deadline = new Date('2026-10-28T12:00:00Z'); jest.setSystemTime(deadline);
      const request = { ...open, departureDateMax: deadline };
      const { manager, query } = setup(request);
      expect((await requestSearchMap(manager, 'owner', 'request')).searching).toBe(false);
      expect(request.status).toBe('pending'); expect(query).not.toHaveBeenCalled();
      jest.setSystemTime(new Date(deadline.getTime() - 1));
      expect((await requestSearchMap(manager, 'owner', 'request')).searching).toBe(true);
      expect(query.mock.calls[0][0]).toContain('r."departureDateMax" > now()');
      expect(query.mock.calls[0][0]).not.toContain("interval '3 hours'");
    } finally { jest.useRealTimers(); }
  });
  it('returns one exact last-known position per vehicle without account or contact fields', async () => {
    const positionUpdatedAt = new Date();
    const { manager, query } = setup(open, [
      { latitude: '-4.3011', longitude: '15.3011', markerSeed: 'one', vehicleType: 'car', positionUpdatedAt, phone: 'never returned' },
      { latitude: '-4.3012', longitude: '15.3012', markerSeed: 'two', vehicleType: 'car', positionUpdatedAt },
    ]);
    const map = await requestSearchMap(manager, 'owner', 'request');
    expect(map).toMatchObject({ requestId: 'request', radiusKm: 5, total: 2, truncated: false,
      groups: [{ id: '-4.3:15.3', latitude: -4.3, longitude: 15.3, count: 2 }] });
    expect(map.vehicles).toHaveLength(2);
    expect(map.vehicles[0]).toEqual({ id: expect.stringMatching(/^[a-f0-9]{64}$/), latitude: -4.3011,
      longitude: 15.3011, vehicleType: 'car', positionUpdatedAt: positionUpdatedAt.toISOString() });
    expect(map.vehicles[1].id).not.toBe(map.vehicles[0].id);
    expect((await requestSearchMap(manager, 'owner', 'request')).vehicles[0].id).toBe(map.vehicles[0].id);
    expect((await requestSearchMap(manager, 'owner', 'another')).vehicles[0].id).not.toBe(map.vehicles[0].id);
    expect(query.mock.calls[0][1]).toEqual(['request', 'owner', 5000]);
    const sql = query.mock.calls[0][0];
    for (const fragment of ['ST_DWithin', 'ST_Distance', 'LIMIT 501', 'trip_request_driver_refusals',
      'o."requestId" <> r.id', 'r."targetDriverId"', 'r."passengerId" = $2::uuid']) expect(sql).toContain(fragment);
    expect(sql).not.toContain("interval '10 minutes'");
  });
  it('keeps older last-known positions with their date but does not expose them to legacy recent-only clients', async () => {
    const positionUpdatedAt = new Date(Date.now() - 8 * 3600000);
    const { manager } = setup(open, [{ latitude: -4.3, longitude: 15.3, markerSeed: 'old', vehicleType: 'motorcycle_2_wheels', positionUpdatedAt }]);
    const map = await requestSearchMap(manager, 'owner', 'request');
    expect(map.vehicles).toEqual([{ id: expect.any(String), latitude: -4.3, longitude: 15.3,
      vehicleType: 'motorcycle_2_wheels', positionUpdatedAt: positionUpdatedAt.toISOString() }]);
    expect(map.groups).toEqual([]);
  });
  it('bounds markers and explicitly signals when the closest 500 were selected', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ latitude: -4.3, longitude: 15.3,
      markerSeed: `vehicle-${i}`, vehicleType: 'car', positionUpdatedAt: new Date() }));
    const { manager } = setup(open, rows);
    const map = await requestSearchMap(manager, 'owner', 'request');
    expect(map.vehicles).toHaveLength(500);
    expect(map).toMatchObject({ total: 500, truncated: true });
  });
  it('does not invent a departure or fetch drivers for a legacy request without coordinates', async () => {
    const { manager, query } = setup({ ...open, departurePoint: null });
    expect(await requestSearchMap(manager, 'owner', 'request')).toMatchObject({ groups: [], total: 0 });
    expect(query).not.toHaveBeenCalled();
  });
});
