import { compactDriverActivity } from './compact-driver-activity';
import type { SanitizedTrip } from './trips.service';

describe('compact driver activity wire format', () => {
  it('deduplicates profiles without dropping bookings, payments or mutating the legacy array', () => {
    const trips = [1, 2].map(n => ({ id: `trip-${n}`, driverId: 'driver',
      driver: { id: 'driver', firstName: 'Fixture' }, status: 'ongoing',
      bookings: [{ id: `booking-${n}`, status: 'accepted', paymentStatus: 'pending' }],
    })) as unknown as SanitizedTrip[];
    const before = JSON.stringify(trips);
    const compact = compactDriverActivity(trips);
    expect(compact.format).toBe('driver-activity-v1');
    expect(Object.keys(compact.drivers)).toEqual(['driver']);
    expect(compact.items.map(trip => ({ ...trip, driver: compact.drivers[trip.driverId] }))).toEqual(trips);
    expect(JSON.stringify(trips)).toBe(before);
  });
  it('handles an empty activity list', () => {
    expect(compactDriverActivity([])).toEqual({ format: 'driver-activity-v1', drivers: {}, items: [] });
  });
});
