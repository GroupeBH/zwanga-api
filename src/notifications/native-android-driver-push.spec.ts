jest.mock('./bounded-firebase-send', () => ({ sendBoundedFirebase: (app: unknown, message: unknown) => require('firebase-admin/messaging').getMessaging(app).send(message) }));
import { nativeAndroidDriverPush } from './native-android-driver-push';
import { Notification } from './entities/notification.entity';
import { NotificationService } from './notifications.service';
import { getMessaging } from 'firebase-admin/messaging';
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));
describe('Android v6 native delivery', () => {
  it.each(['new_booking', 'trip_request_nearby', 'driver_dispatch_offer'])(
    'keeps routing, ownership and original deadline for %s',
    async (type) => {
      const until = new Date(Date.now() + 60000).toISOString();
      const n = {
        id: 'notification',
        userId: 'driver',
        title: 'Test',
        body: 'Test',
        createdAt: new Date(),
        data: {
          type,
          driverId: 'driver',
          passengerId: 'passenger',
          bookingId: 'booking',
          tripRequestId: 'request',
          offerId: 'offer',
          ringAlert: 'nearby-request-v1',
          expiresAt: until,
          sharedTrip: 'true',
          ridePricePerSeat: '2500',
          rideArrival: 'Test',
        },
      } as Notification;
      const payload = nativeAndroidDriverPush(n, 'synthetic-token', until);
      expect(payload.data).toMatchObject({
        nativeAlert: 'driver-v6',
        notificationId: n.id,
        driverId: 'driver',
        passengerId: 'passenger',
        ringUntil: until,
        sharedTrip: 'true',
        ridePricePerSeat: '2500',
      });
      expect(payload.android.priority).toBe('high');
      expect(
        (JSON.parse(payload.data.body) as { ringUntil: string }).ringUntil,
      ).toBe(until);
      const send = jest
        .fn<Promise<string>, [{ data: Record<string, string> }]>()
        .mockResolvedValue('accepted-by-fcm');
      (getMessaging as jest.Mock).mockReturnValue({ send });
      const service = Object.assign(
        Object.create(NotificationService.prototype),
        {
          firebaseApp: {},
          configService: { get: () => 'true' },
          notificationRepository: {
            manager: { query: jest.fn().mockResolvedValue([{ version: 6 }]) },
          },
        },
      ) as {
        sendFirebaseNotification(
          notification: Notification,
          token: string,
        ): Promise<string>;
      };
      await service.sendFirebaseNotification(n, 'synthetic-token');
      expect(send.mock.calls[0][0].data.nativeAlert).toBe('driver-v6');
    },
  );
  it('keeps worst-case unicode prose below the FCM payload budget', () => {
    const payload = nativeAndroidDriverPush(
      {
        id: 'n',
        title: '😀'.repeat(500),
        body: '😀'.repeat(2000),
        data: {
          type: 'new_booking',
          driverId: 'd',
          invitationText: '😀'.repeat(2000),
          rideArrival: '😀'.repeat(2000),
          rideDeparture: '😀'.repeat(2000),
        },
      } as Notification,
      'synthetic-token',
      new Date().toISOString(),
    );
    expect(
      Buffer.byteLength(JSON.stringify(payload.data), 'utf8'),
    ).toBeLessThan(4000);
  });
});
