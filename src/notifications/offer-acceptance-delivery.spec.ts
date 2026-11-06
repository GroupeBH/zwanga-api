import { NotificationService } from './notifications.service';
import { isRideResponseDeliverable } from './ride-response-delivery';
import { claimRideRealtimeNotifications } from './ride-realtime-delivery';
import { getMessaging } from 'firebase-admin/messaging';

jest.mock('./bounded-firebase-send', () => ({ sendBoundedFirebase: (app: unknown, message: unknown) => require('firebase-admin/messaging').getMessaging(app).send(message) }));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

const notice = () => ({ id: 'notice', userId: 'driver', eventKey: 'offer-accepted:offer', isActive: true,
  createdAt: new Date(), title: 'Prix accepté', body: 'Ouvrez la demande',
  data: { type: 'offer_accepted', ringAlert: 'offer-accepted-v1', role: 'driver',
    tripRequestId: 'request', offerId: 'offer', driverId: 'driver', passengerId: 'passenger' } });

describe('accepted request price receipt', () => {
  it('realtime delivery does not depend on a push token, and retains driver ownership', async () => {
    const publish = jest.fn().mockReturnValue(true);
    const service = Object.assign(Object.create(NotificationService.prototype), {
      notificationRepository: { manager: { query: jest.fn().mockResolvedValue([{}]) } }, rideAlerts: { publish },
      userRepository: { findOne: jest.fn(() => { throw new Error('Push token must not gate socket'); }) },
    });
    await service.publishRealtimeInvitation(notice());
    expect(publish).toHaveBeenCalledWith('driver', expect.objectContaining({ kind: 'incoming', eventId: 'notice',
      data: expect.objectContaining({ type: 'offer_accepted', driverId: 'driver', passengerId: 'passenger', role: 'driver' }) }));
    publish.mockClear(); service.notificationRepository.manager.query.mockResolvedValue([]);
    await service.publishRealtimeInvitation(notice()); expect(publish).not.toHaveBeenCalled();
  });

  it('a failed realtime publication remains retryable; an old receipt never rings again', async () => {
    const service = Object.assign(Object.create(NotificationService.prototype), {
      notificationRepository: { manager: { query: async () => [{}] } }, rideAlerts: { publish: () => false },
    });
    await expect(service.publishRealtimeInvitation(notice())).rejects.toThrow('Realtime transport unavailable');
    await expect(service.publishRealtimeInvitation({ ...notice(), createdAt: new Date(Date.now() - 61_000) })).resolves.toBeUndefined();
  });

  it('revalidates the accepted offer, request owner and selected driver, using bound identifiers', async () => {
    const query = jest.fn().mockResolvedValue([{}]);
    expect(await isRideResponseDeliverable({ query } as any, notice() as any)).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['offer', 'request', 'driver']);
    expect(sql).toContain("o.status='accepted'"); expect(sql).toContain('r."selectedDriverId"=o."driverId"');
    expect(sql).toContain("r.status='driver_selected'"); expect(sql).toContain("t.status IN ('upcoming','ongoing')");
    query.mockResolvedValue([]); expect(await isRideResponseDeliverable({ query } as any, notice() as any)).toBe(false);
  });

  it('claims accepted-price receipts in the durable realtime lane', async () => {
    const query = jest.fn().mockResolvedValue([{ notificationId: 'notice' }]);
    expect(await claimRideRealtimeNotifications({ query } as any)).toEqual(['notice']);
    expect(query.mock.calls[0][0]).toContain("'offer-accepted-v1'");
  });

  it.each([0, 5, 6])('keeps a visible FCM push and correct recipient on capability %s', async version => {
    const send = jest.fn().mockResolvedValue('message'); (getMessaging as jest.Mock).mockReturnValue({ send });
    const service = Object.assign(Object.create(NotificationService.prototype), {
      firebaseApp: {}, configService: { get: () => 'true' },
      notificationRepository: { manager: { query: async () => version ? [{ version }] : [] } },
    });
    await service.sendFirebaseNotification(notice(), 'fixture-token');
    const payload = send.mock.calls[0][0];
    expect(payload.data).toMatchObject({ type: 'offer_accepted', driverId: 'driver', passengerId: 'passenger', role: 'driver' });
    expect(payload.notification || payload.apns?.payload?.aps?.alert).toBeDefined();
    expect(payload.data.actionProtocol).toBeUndefined();
  });
});
