import type { Point } from 'typeorm';
import type { Trip } from '../trips/entities/trip.entity';
import {
  assertBookingPickupNearRoute,
  bookingRouteSignature,
  pickupSegmentDistance,
} from './booking-pickup-route';

// Synthetic routes only, no provider requests or application database.
const point = (lat: number, lng: number): Point => ({
  type: 'Point',
  coordinates: [lng, lat],
});
const encode = (points: number[][]) => {
  let previous = [0, 0],
    result = '';
  for (const p of points) {
    const current = p.map((n) => Math.round(n * 1e5));
    for (let i = 0; i < 2; i++) {
      const delta = current[i] - previous[i];
      let v = delta < 0 ? -delta * 2 - 1 : delta * 2;
      while (v >= 32) {
        result += String.fromCharCode((v % 32) + 95);
        v = Math.floor(v / 32);
      }
      result += String.fromCharCode(v + 63);
    }
    previous = current;
  }
  return result;
};
const route = (
  points = [
    [0, 15],
    [0, 15.1],
  ],
) => ({
  status: 'OK',
  routes: [
    {
      overviewPolyline: encode([
        [0, 15],
        [0, 15.1],
      ]),
      legs: [{ steps: [{ polyline: encode(points) }] }],
    },
  ],
});
const fixture = () => ({
  trip: {
    departurePoint: point(0, 15),
    arrivalPoint: point(0, 15.1),
    tripRequestId: null,
  } as Trip,
  maps: { getDirections: jest.fn().mockResolvedValue(route()) },
});
const offset = (meters: number) =>
  point(((meters / 6371000) * 180) / Math.PI, 15.05);

describe('100 metre pickup corridor for a published trip', () => {
  it.each([0, 1, 99.9, 100])(
    'allows a pickup at %s m from a segment, far from its vertices',
    async (distance) => {
      const f = fixture();
      await expect(
        assertBookingPickupNearRoute(f.trip, offset(distance), f.maps),
      ).resolves.toBeUndefined();
      expect(f.maps.getDirections).toHaveBeenCalledWith(
        {
          origin: { lat: 0, lng: 15 },
          destination: { lat: 0, lng: 15.1 },
          mode: 'driving',
          alternatives: false,
        },
        { timeoutMs: 6000 },
      );
    },
  );
  it.each([100.01, 101, 500, 2000])(
    'rejects a pickup at %s m',
    async (distance) => {
      const f = fixture();
      await expect(
        assertBookingPickupNearRoute(f.trip, offset(distance), f.maps),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'BOOKING_PICKUP_OFF_ROUTE', maxDistanceMeters: 100 },
      });
    },
  );
  it('measures a finite segment, including before departure and after arrival', () => {
    const start = { lat: 0, lng: 15 },
      end = { lat: 0, lng: 15.1 };
    expect(
      pickupSegmentDistance({ lat: 0, lng: 14.99 }, start, end),
    ).toBeGreaterThan(1000);
    expect(
      pickupSegmentDistance({ lat: 0, lng: 15.11 }, start, end),
    ).toBeGreaterThan(1000);
    expect(pickupSegmentDistance(start, start, start)).toBe(0);
    expect(
      pickupSegmentDistance({ lat: 0, lng: 15.01 }, start, start),
    ).toBeGreaterThan(1000);
  });
  it('measures diagonal segments and wraps longitude at the dateline', () => {
    expect(
      pickupSegmentDistance(
        { lat: -4.31, lng: 15.31 },
        { lat: -4.32, lng: 15.3 },
        { lat: -4.3, lng: 15.32 },
      ),
    ).toBeLessThan(1);
    expect(
      pickupSegmentDistance(
        { lat: 0, lng: 180 },
        { lat: 0, lng: 179.9 },
        { lat: 0, lng: -179.9 },
      ),
    ).toBeLessThan(0.001);
  });
  it('uses detailed steps, never a simplified overview or a straight endpoint line', async () => {
    const f = fixture();
    f.maps.getDirections.mockResolvedValue(
      route([
        [0, 15],
        [0.01, 15.05],
        [0, 15.1],
      ]),
    );
    await expect(
      assertBookingPickupNearRoute(f.trip, point(0.01, 15.05), f.maps),
    ).resolves.toBeUndefined();
    await expect(
      assertBookingPickupNearRoute(f.trip, point(0, 15.05), f.maps),
    ).rejects.toMatchObject({ response: { code: 'BOOKING_PICKUP_OFF_ROUTE' } });
  });
  it('does not invent a segment across disconnected steps', async () => {
    const f = fixture(),
      data = route();
    data.routes[0].legs[0].steps = [
      {
        polyline: encode([
          [0, 15],
          [0, 15.01],
        ]),
      },
      {
        polyline: encode([
          [0, 15.09],
          [0, 15.1],
        ]),
      },
    ];
    f.maps.getDirections.mockResolvedValue(data);
    await expect(
      assertBookingPickupNearRoute(f.trip, offset(0), f.maps),
    ).rejects.toMatchObject({ response: { code: 'BOOKING_PICKUP_OFF_ROUTE' } });
  });
  it.each([
    undefined,
    { status: 'ZERO_RESULTS', routes: [] },
    { status: 'OK', routes: [] },
    { status: 'OK', routes: [{ legs: [] }] },
    ...['', '_', '~~~~~~~', '!', '?'.repeat(500_002)].map((polyline) => ({
      status: 'OK',
      routes: [{ legs: [{ steps: [{ polyline }] }] }],
    })),
  ])(
    'fails closed on missing, malformed or oversized directions (%#)',
    async (data) => {
      const f = fixture();
      f.maps.getDirections.mockResolvedValue(data);
      await expect(
        assertBookingPickupNearRoute(f.trip, offset(1), f.maps),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: 'BOOKING_PICKUP_ROUTE_UNAVAILABLE' },
      });
    },
  );
  it('a provider failure does not turn into an off-route verdict or a successful booking', async () => {
    const f = fixture();
    f.maps.getDirections.mockRejectedValue(Error('timeout'));
    await expect(
      assertBookingPickupNearRoute(f.trip, offset(1), f.maps),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'BOOKING_PICKUP_ROUTE_UNAVAILABLE' },
    });
  });
  it.each([null, point(NaN, 15), point(91, 15), point(0, 0)])(
    'rejects a pickup without valid coordinates (%#)',
    async (pickup) => {
      const f = fixture();
      await expect(
        assertBookingPickupNearRoute(f.trip, pickup, f.maps),
      ).rejects.toMatchObject({
        response: { code: 'BOOKING_PICKUP_LOCATION_REQUIRED' },
      });
      expect(f.maps.getDirections).not.toHaveBeenCalled();
    },
  );
  it('requires trip endpoints, but the exact published departure needs no provider read', async () => {
    const f = fixture();
    await expect(
      assertBookingPickupNearRoute(f.trip, f.trip.departurePoint, f.maps),
    ).resolves.toBeUndefined();
    expect(f.maps.getDirections).not.toHaveBeenCalled();
    f.trip.arrivalPoint = null;
    await expect(
      assertBookingPickupNearRoute(f.trip, offset(1), f.maps),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('does not apply this published-route policy to a private passenger request', async () => {
    const f = fixture();
    f.trip.tripRequestId = 'request';
    await expect(
      assertBookingPickupNearRoute(f.trip, null, f.maps),
    ).resolves.toBeUndefined();
    expect(f.maps.getDirections).not.toHaveBeenCalled();
  });
  it('route signature changes on endpoint or request changes, not driver movement', () => {
    const { trip } = fixture(),
      signature = bookingRouteSignature(trip);
    expect(
      bookingRouteSignature({ ...trip, currentLocation: point(1, 1) } as Trip),
    ).toBe(signature);
    expect(
      bookingRouteSignature({ ...trip, arrivalPoint: point(0.1, 15) }),
    ).not.toBe(signature);
    expect(
      bookingRouteSignature({ ...trip, departurePoint: point(0.1, 15) }),
    ).not.toBe(signature);
    expect(
      bookingRouteSignature({ ...trip, tripRequestId: 'request' }),
    ).not.toBe(signature);
  });
});
