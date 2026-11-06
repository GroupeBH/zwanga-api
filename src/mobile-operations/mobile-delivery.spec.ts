import { randomUUID } from 'node:crypto';
import { NotificationService } from '../notifications/notifications.service';
import { sendBoundedFirebase } from '../notifications/bounded-firebase-send';
import { ownPushClaim } from '../notifications/notification-push-claim';
import { NotificationStatus } from '../notifications/entities/notification.entity';
jest.mock('../notifications/bounded-firebase-send', () => ({
  sendBoundedFirebase: jest.fn(),
  prewarmFirebaseAccessToken: jest.fn(),
}));

describe('Mobile campaigns reuse bounded Firebase and preserve ride workers', () => {
  function fixture() {
    const query = jest.fn(async () => [
      { pushToken: 'synthetic-current-token' },
    ]);
    const repo = {
      manager: { query },
      update: jest.fn(async () => ({ affected: 1 })),
      save: jest.fn(async (x) => x),
    };
    const users = { findOne: jest.fn(), count: jest.fn(), update: jest.fn() };
    const service: any = new NotificationService(
      { get: () => 'true' } as any,
      repo as any,
      users as any,
      {} as any,
    );
    service.firebaseApp = {};
    const n: any = {
      id: randomUUID(),
      title: 'Maintenance',
      body: 'Information',
      userId: null,
      fcmToken: 'old-token',
      status: NotificationStatus.PENDING,
      isActive: true,
      data: {
        type: 'mobile_campaign',
        campaignId: randomUUID(),
        installationId: randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    };
    ownPushClaim(n, 'CRITICAL_PUSH_RETRY_CLAIMED:test');
    return { service, n, query, repo, users };
  }
  beforeEach(() => jest.clearAllMocks());
  it('resolves rotated token and uses normal priority, bounded TTL, no ring payload', async () => {
    const f = fixture();
    jest.mocked(sendBoundedFirebase).mockResolvedValue('provider-message-id');
    expect(await f.service.deliverSavedNotification(f.n)).toBe(true);
    const payload = jest.mocked(sendBoundedFirebase).mock.calls[0][1];
    expect(payload).toMatchObject({
      token: 'synthetic-current-token',
      android: {
        priority: 'normal',
        notification: { channelId: 'zwanga_default' },
      },
    });
    expect(payload.android?.ttl).toBeLessThanOrEqual(60000);
    expect(payload.data?.ringUntil).toBeUndefined();
    expect(f.users.findOne).not.toHaveBeenCalled();
  });
  it('suppresses cancelled, unsubscribed or expired work before calling Firebase', async () => {
    const f = fixture();
    f.query.mockResolvedValue([]);
    expect(await f.service.deliverSavedNotification(f.n)).toBe(false);
    expect(sendBoundedFirebase).not.toHaveBeenCalled();
    expect(f.repo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isActive: false }),
    );
  });
  it('refuses a campaign row that could bypass installation consent with an account token', async () => {
    const f = fixture();
    f.n.userId = randomUUID();
    expect(await f.service.deliverSavedNotification(f.n)).toBe(false);
    expect(sendBoundedFirebase).not.toHaveBeenCalled();
    expect(f.users.findOne).not.toHaveBeenCalled();
  });
});
