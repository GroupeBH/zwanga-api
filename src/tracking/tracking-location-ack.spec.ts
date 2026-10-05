import { TrackingGateway } from './tracking.gateway';
import { normalizeLocationRecordedAt } from '../common/utils/tracking-coordinates';

describe('tracking acknowledgements', () => {
  const fixture = () => {
    const trips = { updateDriverLocation: jest.fn() };
    const bookings = { updatePassengerLocation: jest.fn(), evaluateAutomaticRideProgressForTrip: jest.fn().mockResolvedValue({ events: [] }) };
    const gateway = new TrackingGateway(trips as any, bookings as any, {} as any, { get: () => '0' } as any, {} as any);
    const emit = jest.fn();
    gateway.server = { to: () => ({ emit }) } as any;
    return { trips, bookings, gateway, emit, client: { data: { userId: 'synthetic-user' }, emit: jest.fn() } as any };
  };
  const data = { tripId: 'trip', coordinates: [15.3, -4.3] as [number, number], recordedAt: '2026-10-04T10:00:10.000Z' };

  for (const passenger of [false, true]) for (const superseded of [false, true]) {
    it(`acknowledges ${passenger ? 'passenger' : 'driver'} ${superseded ? 'superseded' : 'accepted'} samples despite clock normalization`, async () => {
      const env = fixture();
      const updatedAt = normalizeLocationRecordedAt(data.recordedAt, new Date('2026-10-04T10:00:00.000Z'));
      const location = { ...data, ...(passenger ? { bookingId: 'booking' } : {}), updatedAt,
        ignoredAsOutOfOrder: superseded, autoProgress: { events: [] } };
      env.trips.updateDriverLocation.mockResolvedValue(location);
      env.bookings.updatePassengerLocation.mockResolvedValue(location);
      const response = passenger
        ? await env.gateway.handlePassengerLocationUpdate(env.client, { ...data, bookingId: 'booking' })
        : await env.gateway.handleDriverLocationUpdate(env.client, data);
      expect(response).toMatchObject({ success: true, status: superseded ? 'superseded' : 'accepted', tripId: data.tripId, recordedAt: data.recordedAt, updatedAt });
      expect(env.emit).toHaveBeenCalledWith(passenger ? 'passenger_location' : 'driver_location', expect.objectContaining({ updatedAt }));
      if (passenger) expect(response).toHaveProperty('bookingId', 'booking');
    });
  }

  for (const passenger of [false, true]) it(`never acknowledges a rejected ${passenger ? 'passenger' : 'driver'} write as success`, async () => {
    const env = fixture();
    env.trips.updateDriverLocation.mockRejectedValue(new Error('rejected'));
    env.bookings.updatePassengerLocation.mockRejectedValue(new Error('rejected'));
    const response = passenger
      ? await env.gateway.handlePassengerLocationUpdate(env.client, { ...data, bookingId: 'booking' })
      : await env.gateway.handleDriverLocationUpdate(env.client, data);
    expect(response).toEqual({ success: false });
    expect(env.emit).not.toHaveBeenCalled();
    expect(env.client.emit).toHaveBeenCalled();
  });

  it('waits for server acceptance and keeps automatic progress events', async () => {
    const env = fixture();
    let accept!: (value: any) => void;
    env.trips.updateDriverLocation.mockReturnValue(new Promise(resolve => { accept = resolve; }));
    const progress = { events: [{ type: 'pickup_confirmed', tripId: 'trip' }] };
    env.bookings.evaluateAutomaticRideProgressForTrip.mockResolvedValue(progress);
    let settled = false;
    const response = env.gateway.handleDriverLocationUpdate(env.client, data).then(value => { settled = true; return value; });
    await Promise.resolve(); expect(settled).toBe(false);
    accept({ ...data, updatedAt: data.recordedAt });
    expect(await response).toMatchObject({ success: true });
    expect(env.emit).toHaveBeenCalledWith('booking_auto_progress', progress);
  });
});
