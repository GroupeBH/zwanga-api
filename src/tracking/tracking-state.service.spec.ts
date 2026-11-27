import { NotFoundException } from '@nestjs/common';
import { TrackingStateService } from './tracking-state.service';
import { TrackingStateChangedException } from '../common/tracking-state-changed.exception';
import { TrackingGateway } from './tracking.gateway';

describe('tracking state recovery', () => {
  it('preserves terminal HTTP fallback behavior for already deployed mobile clients', () => {
    for (const bookingId of [undefined, 'booking']) {
      const e = new TrackingStateChangedException('trip', bookingId);
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({ code: 'TRACKING_STATE_CHANGED', message: expect.stringContaining(bookingId ? 'réservations acceptées' : 'plus en cours') });
    }
  });
  it('uses bound caller identity and booking ownership, never returns positions', async () => {
    const query = jest.fn().mockResolvedValue([{ tripId: 'trip', tripStatus: 'completed' }]);
    const service = new TrackingStateService({ query } as any);
    await expect(service.read('user', 'trip', 'booking')).resolves.toEqual({ tripId: 'trip', tripStatus: 'completed' });
    const [sql, args] = query.mock.calls[0];
    expect(args).toEqual(['user', 'trip', 'booking']);
    expect(sql).toContain('b."passengerId"=$1');
    expect(sql).toContain('t."driverId"=$1');
    expect(sql).not.toMatch(/Point|coordinates|SELECT \*/);
    query.mockResolvedValue([]);
    await expect(service.read('outsider', 'trip')).rejects.toBeInstanceOf(NotFoundException);
  });

  for (const passenger of [false, true]) it(`recovers ${passenger ? 'passenger' : 'driver'} terminal writes without a false GPS success`, async () => {
    const error = new TrackingStateChangedException('trip', passenger ? 'booking' : undefined);
    const trips = { updateDriverLocation: jest.fn().mockRejectedValue(error) };
    const bookings = { updatePassengerLocation: jest.fn().mockRejectedValue(error) };
    const state = { read: jest.fn().mockResolvedValue({ tripId: 'trip', tripStatus: 'completed' }) };
    const gateway = new TrackingGateway(trips as any, bookings as any, {} as any, {} as any, {} as any, state as any);
    const client = { data: { userId: 'owner' }, emit: jest.fn() } as any;
    const data = { tripId: 'trip', bookingId: 'booking', coordinates: [15.31, -4.3] as [number, number], recordedAt: '2026-11-22T12:00:00Z' };
    const ack = passenger ? await gateway.handlePassengerLocationUpdate(client, data) : await gateway.handleDriverLocationUpdate(client, data);
    expect(ack).toMatchObject({ success: false, status: 'state_changed', code: 'TRACKING_STATE_CHANGED', recordedAt: data.recordedAt });
    expect(client.emit).not.toHaveBeenCalled();
    expect(await gateway.handleGetTrackingState(client, { tripId: 'trip' })).toMatchObject({ success: true });
    expect(state.read).toHaveBeenCalledWith('owner', 'trip', undefined);
    state.read.mockRejectedValue(new NotFoundException());
    expect(await gateway.handleGetTrackingState(client, { tripId: 'other' })).toEqual({ success: false });
  });
});
