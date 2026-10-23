import { NotificationService } from './notifications.service';
import { prepareNearbyRequestRinging } from './nearby-request-cooldown';
import { claimRideRealtimeNotifications } from './ride-realtime-delivery';

jest.mock('./nearby-request-cooldown', () => ({
  ...jest.requireActual('./nearby-request-cooldown'), prepareNearbyRequestRinging: jest.fn(),
}));
jest.mock('./ride-realtime-delivery', () => ({ claimRideRealtimeNotifications: jest.fn() }));

describe('independent ride realtime delivery', () => {
  const fixture = () => {
    const notice = { id: 'notice', userId: 'driver', isActive: true, createdAt: new Date(),
      status: 'failed', body: 'Test', data: { type: 'driver_dispatch_offer', passengerId: 'passenger' } };
    const query = jest.fn().mockResolvedValue([]);
    const publish = jest.fn().mockReturnValue(true);
    const service = new NotificationService({ get: () => 'true' } as any,
      { findBy: async () => [notice], manager: { query } } as any,
      { findOne: async () => ({ id: 'driver', role: 'driver', isActive: true, status: 'active' }) } as any,
      {} as any, { isBound: () => true, publish } as any);
    jest.spyOn(service as any, 'isCriticalNotificationStillDeliverable').mockResolvedValue(true);
    const send = jest.spyOn(service as any, 'sendFirebaseNotification').mockImplementation(() => new Promise(() => {}));
    jest.mocked(prepareNearbyRequestRinging).mockResolvedValue(true);
    jest.mocked(claimRideRealtimeNotifications).mockResolvedValue(['notice']);
    return { service, notice, query, publish, send };
  };
  afterEach(() => jest.restoreAllMocks());
  it('publishes even with all five push slots occupied and the push marked failed', async () => {
    const f = fixture(); f.service['urgentWorkers'] = 5;
    await f.service.dispatchRealtimeNotifications();
    expect(f.publish).toHaveBeenCalledWith('driver', expect.objectContaining({ kind: 'incoming', eventId: 'notice',
      data: expect.objectContaining({ notificationId: 'notice' }) }));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('"completedAt"'), ['notice']);
  });
  it.each(['expired', 'muted', 'self'])('does not deliver a %s invitation', async reason => {
    const f = fixture();
    if (reason === 'expired') f.notice.createdAt = new Date(0);
    if (reason === 'muted') jest.mocked(prepareNearbyRequestRinging).mockResolvedValue(false);
    if (reason === 'self') f.notice.data.passengerId = 'driver';
    await f.service.dispatchRealtimeNotifications(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('leaves the lease retryable on transport or database failure and releases the process guard', async () => {
    const f = fixture(); f.publish.mockReturnValue(false);
    await f.service.dispatchRealtimeNotifications();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.service['dispatchingRealtime']).toBe(false);
    f.publish.mockReturnValue(true);
    await f.service.dispatchRealtimeNotifications();
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
