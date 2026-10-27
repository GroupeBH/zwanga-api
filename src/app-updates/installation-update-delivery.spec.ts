import { randomUUID } from 'crypto';
import { getMessaging } from 'firebase-admin/messaging';
import { NotificationService } from '../notifications/notifications.service';
import { NotificationStatus } from '../notifications/entities/notification.entity';

jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

type Dependencies = ConstructorParameters<typeof NotificationService>;
type DeliveryInternals = {
  deliverSavedNotification(value: unknown): Promise<boolean>;
  sendFirebaseNotification(value: unknown, token: string): Promise<string>;
  claimExpoPushReceipts(): Promise<unknown[]>;
  claimCriticalFinancialNotifications(): Promise<unknown[]>;
  isCriticalNotificationStillDeliverable(value: unknown): Promise<boolean>;
};
describe('anonymous update outbox delivery', () => {
  function fixture() {
    const query = jest
      .fn()
      .mockResolvedValue([{ pushToken: 'synthetic-current-token' }]);
    const repository = {
      manager: { query },
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const users = { findOne: jest.fn(), count: jest.fn(), update: jest.fn() };
    const service = new NotificationService(
      { get: () => 'true' } as unknown as Dependencies[0],
      repository as unknown as Dependencies[1],
      users as unknown as Dependencies[2],
      {} as Dependencies[3],
    );
    const item = {
      id: randomUUID(),
      userId: null,
      fcmToken: 'synthetic-old-token',
      title: 'Mise à jour',
      body: 'Version disponible',
      status: NotificationStatus.PENDING,
      isActive: true,
      messageId: null as string | null,
      data: {
        type: 'app_update',
        installationId: randomUUID(),
        releaseId: '1',
      },
    };
    return {
      service,
      internal: service as unknown as DeliveryInternals,
      item,
      query,
      users,
      repository,
    };
  }
  afterEach(() => jest.restoreAllMocks());
  it('sends without an account, resolving the current token and a normal notification payload', async () => {
    const f = fixture(),
      send = jest.fn().mockResolvedValue('synthetic-message');
    (getMessaging as jest.Mock).mockReturnValue({ send });
    Object.assign(f.service, { firebaseApp: {} });
    expect(await f.internal.deliverSavedNotification(f.item)).toBe(true);
    expect(f.users.findOne).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'synthetic-current-token',
        android: {
          priority: 'normal',
          ttl: 86400000,
          notification: { channelId: 'zwanga_default' },
        },
        notification: { title: 'Mise à jour', body: 'Version disponible' },
      }),
    );
    expect(f.item.status).toBe(NotificationStatus.SENT);
  });
  it('withdrawn consent suppresses an already queued notification before provider delivery', async () => {
    const f = fixture();
    f.query.mockResolvedValue([]);
    const send = jest.spyOn(f.internal, 'sendFirebaseNotification');
    expect(await f.internal.deliverSavedNotification(f.item)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(f.item.isActive).toBe(false);
  });
  it('an invalid native token disables only the token that actually failed', async () => {
    const f = fixture();
    jest.spyOn(f.internal, 'sendFirebaseNotification').mockRejectedValue(
      Object.assign(Error('synthetic expired'), {
        code: 'messaging/registration-token-not-registered',
      }),
    );
    expect(await f.internal.deliverSavedNotification(f.item)).toBe(false);
    expect(f.query).toHaveBeenLastCalledWith(
      expect.stringContaining('AND "pushToken"=$2'),
      [f.item.data.installationId, 'synthetic-current-token'],
    );
    expect(f.users.update).not.toHaveBeenCalled();
  });
  it('a delayed invalid Expo receipt revokes only its old installation token', async () => {
    const f = fixture();
    f.item.messageId = 'expo-ticket:synthetic-ticket';
    jest.spyOn(f.internal, 'claimExpoPushReceipts').mockResolvedValue([f.item]);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            'synthetic-ticket': {
              status: 'error',
              details: { error: 'DeviceNotRegistered' },
            },
          },
        }),
    } as Response);
    await f.service.reconcileExpoPushReceipts();
    expect(f.query).toHaveBeenLastCalledWith(
      expect.stringContaining('AND "pushToken"=$2'),
      [f.item.data.installationId, 'synthetic-old-token'],
    );
    expect(f.item.status).toBe(NotificationStatus.FAILED);
  });
  it('retry permits anonymous updates but still rejects financial notifications without a user', async () => {
    const f = fixture();
    const financial = {
      ...f.item,
      id: randomUUID(),
      data: { type: 'driver_trip_revenue' },
    };
    jest
      .spyOn(f.internal, 'claimCriticalFinancialNotifications')
      .mockResolvedValue([f.item, financial]);
    jest
      .spyOn(f.internal, 'isCriticalNotificationStillDeliverable')
      .mockResolvedValue(true);
    const deliver = jest
      .spyOn(f.internal, 'deliverSavedNotification')
      .mockResolvedValue(true);
    await f.service.retryCriticalFinancialNotifications();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(f.item);
    expect(financial.status).toBe(NotificationStatus.FAILED);
  });
});
