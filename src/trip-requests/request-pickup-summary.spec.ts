import type { EntityManager } from 'typeorm';
import type { GoogleMapsService } from '../google-maps/google-maps.service';
import {
  requestPickupSummary,
  type PickupSummaryRow,
} from './request-pickup-summary';

describe('accepted request pickup summary', () => {
  const fixture = () => {
    const row: PickupSummaryRow = {
      id: 'request',
      selectedDriverId: 'driver',
      passengerId: 'passenger',
      selectedAt: '2026-11-14T10:00:00Z',
      tripId: null,
      location: 'Point de test',
      reference: 'Entrée',
      pickupLat: -4.3,
      pickupLng: 15.3,
      driverLat: -4.31,
      driverLng: 15.31,
      driverPositionAt: new Date(),
      passengerLat: null,
      passengerLng: null,
      passengerPositionAt: null,
      driverName: 'Conducteur Test',
      passengerName: 'Passager Test',
      brand: 'Test',
      model: 'Test',
      color: 'Bleu',
      licensePlate: 'TEST',
      departureAt: new Date(),
      interruptionStatus: null,
    };
    const query = jest
      .fn()
      .mockImplementation(() => Promise.resolve([{ ...row }]));
    const getDirections = jest
      .fn()
      .mockResolvedValue({
        routes: [
          { legs: [{ distance: 2400, duration: 400, durationInTraffic: 600 }] },
        ],
      });
    const run = (userId = 'passenger') =>
      requestPickupSummary(
        { query } as unknown as EntityManager,
        { getDirections } as unknown as GoogleMapsService,
        'request',
        userId,
      );
    return { row, query, getDirections, run };
  };
  it.each(['driver', 'passenger'])(
    'uses the same road distance and traffic duration for %s',
    async (user) => {
      const f = fixture(),
        result = await f.run(user);
      expect(result.viewerRole).toBe(user);
      expect(result.estimate).toMatchObject({
        distanceMeters: 2400,
        durationSeconds: 600,
        source: 'google_maps',
      });
      expect(f.getDirections).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: { lat: -4.31, lng: 15.31 },
          destination: { lat: -4.3, lng: 15.3 },
        }),
        { timeoutMs: 5000 },
      );
      expect(result.passenger.position).toBeNull();
    },
  );
  it('does not call the provider before authorization', async () => {
    const f = fixture();
    f.query.mockResolvedValue([]);
    await expect(f.run('stranger')).rejects.toThrow('indisponible');
    expect(f.getDirections).not.toHaveBeenCalled();
  });
  it.each([null, new Date(0), new Date(Date.now() + 120_000)])(
    'never estimates from an absent, stale or future position %s',
    async (at) => {
      const f = fixture();
      f.row.driverPositionAt = at;
      expect(await f.run()).toMatchObject({
        status: 'waiting_location',
        estimate: null,
        driver: { position: null },
      });
      expect(f.getDirections).not.toHaveBeenCalled();
    },
  );
  it('keeps pickup details but no fictional estimate on provider failure', async () => {
    const f = fixture();
    f.getDirections.mockRejectedValue(new Error('timeout'));
    expect(await f.run()).toMatchObject({
      status: 'unavailable',
      estimate: null,
      pickup: { location: 'Point de test' },
    });
  });
  it('rejects cancellation or reassignment during the external call', async () => {
    for (const replacement of [
      [],
      [{ ...fixture().row, selectedDriverId: 'another' }],
    ]) {
      const f = fixture();
      f.query.mockResolvedValueOnce([f.row]).mockResolvedValueOnce(replacement);
      await expect(f.run()).rejects.toThrow('changé');
    }
  });
  it('honors an explicit location opt-out during routing', async () => {
    const f = fixture();
    f.query
      .mockResolvedValueOnce([f.row])
      .mockResolvedValueOnce([
        { ...f.row, driverLat: null, driverLng: null, driverPositionAt: null },
      ]);
    expect(await f.run()).toMatchObject({
      estimate: null,
      driver: { position: null },
    });
  });
  it('does not estimate a paused trip', async () => {
    const f = fixture();
    f.row.interruptionStatus = 'confirmed';
    expect(await f.run()).toMatchObject({ status: 'paused', estimate: null });
    expect(f.getDirections).not.toHaveBeenCalled();
  });
});
