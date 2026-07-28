import {
  isCoordinateAllowedForTrip,
  isFreshLocationTimestamp,
  normalizeLatLngCoordinate,
  normalizeLngLatCoordinates,
} from './tracking-coordinates';

describe('tracking coordinates', () => {
  const kinshasaTrip = {
    departurePoint: {
      type: 'Point' as const,
      coordinates: [15.3222, -4.325],
    },
    arrivalPoint: {
      type: 'Point' as const,
      coordinates: [15.3136, -4.3276],
    },
  };

  it('normalizes Kinshasa lat/lng coordinates', () => {
    expect(normalizeLatLngCoordinate(-4.3276, 15.3136)).toEqual({
      latitude: -4.3276,
      longitude: 15.3136,
    });
  });

  it('repairs swapped coordinates when the swapped value is inside the DRC', () => {
    expect(normalizeLatLngCoordinate(15.3136, -4.3276)).toEqual({
      latitude: -4.3276,
      longitude: 15.3136,
    });
    expect(normalizeLngLatCoordinates([-4.3276, 15.3136])).toEqual([
      15.3136,
      -4.3276,
    ]);
  });

  it('rejects null-island and coordinates outside the DRC', () => {
    expect(normalizeLatLngCoordinate(0, 0)).toBeNull();
    expect(normalizeLatLngCoordinate(48.8566, 2.3522)).toBeNull();
  });

  it('keeps live tracking inside Kinshasa for Kinshasa routes', () => {
    expect(
      isCoordinateAllowedForTrip(
        { latitude: -4.3276, longitude: 15.3136 },
        kinshasaTrip,
      ),
    ).toBe(true);
    expect(
      isCoordinateAllowedForTrip(
        { latitude: -5.8962, longitude: 22.4166 },
        kinshasaTrip,
      ),
    ).toBe(false);
  });

  it('treats old location timestamps as stale', () => {
    const now = new Date('2026-07-27T10:02:00.000Z');
    expect(
      isFreshLocationTimestamp('2026-07-27T10:01:00.000Z', now),
    ).toBe(true);
    expect(
      isFreshLocationTimestamp('2026-07-27T10:00:00.000Z', now),
    ).toBe(false);
  });
});
