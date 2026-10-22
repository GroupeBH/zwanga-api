import { NotificationService } from './notifications.service';
import { NotificationStatus } from './entities/notification.entity';
import {
  isNearbyRingingRequest,
  prepareNearbyRequestRinging,
  reconcileNearbyRequestCooldowns,
} from './nearby-request-cooldown';
import { NearbyRequestRingingCooldown1780000087000 } from '../database/migrations/1780000087000-NearbyRequestRingingCooldown';

jest.mock('./nearby-request-cooldown', () => ({
  ...jest.requireActual('./nearby-request-cooldown'),
  prepareNearbyRequestRinging: jest.fn(),
  reconcileNearbyRequestCooldowns: jest.fn(),
}));

const fixture = (expo = false) => {
  const notices = { save: jest.fn(async (n) => n), manager: {} };
  const users = {
    findOne: jest.fn(async () => ({
      role: 'driver',
      isActive: true,
      status: 'active',
      fcmToken: expo ? 'ExponentPushToken[fixture]' : 'fixture',
    })),
    count: jest.fn(async () => 1),
  };
  const service = new NotificationService(
    { get: jest.fn() } as never,
    notices as never,
    users as never,
    {} as never,
  );
  const fcm = jest
    .spyOn(service as any, 'sendFirebaseNotification')
    .mockResolvedValue('message');
  const apns = jest
    .spyOn(service as any, 'sendExpoPushNotification')
    .mockResolvedValue('message');
  const deliver = (type: string) =>
    (service as any).deliverSavedNotification({
      id: 'fixture',
      userId: 'driver',
      data: { type, tripRequestId: 'order', passengerId: 'passenger' },
      status: NotificationStatus.PENDING,
    });
  return { notices, deliver, fcm, apns, service };
};

describe('nearby ringing cooldown delivery boundary', () => {
  beforeEach(() => {
    jest.mocked(prepareNearbyRequestRinging).mockReset();
    jest.mocked(reconcileNearbyRequestCooldowns).mockReset();
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(['trip_request_nearby', 'driver_dispatch_offer'])(
    'recognises %s only as a nearby order',
    (type) => {
      expect(isNearbyRingingRequest({ type })).toBe(true);
    },
  );
  it.each([false, true])(
    'stops both transports before sending when the server pauses ringing (Expo=%s)',
    async (expo) => {
      const f = fixture(expo);
      jest.mocked(prepareNearbyRequestRinging).mockResolvedValue(false);
      for (const type of ['trip_request_nearby', 'driver_dispatch_offer'])
        expect(await f.deliver(type)).toBe(false);
      expect(f.fcm).not.toHaveBeenCalled();
      expect(f.apns).not.toHaveBeenCalled();
      expect(f.notices.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isActive: false,
          errorMessage: 'NEARBY_REQUEST_RINGING_PAUSED_OR_HANDLED',
        }),
      );
    },
  );
  it.each([
    'new_booking',
    'booking_response',
    'trip_request_accepted',
    'trip_started',
    'driver_near_pickup',
  ])('preserves %s without querying the counter', async (type) => {
    const f = fixture();
    jest.mocked(prepareNearbyRequestRinging).mockResolvedValue(false);
    expect(await f.deliver(type)).toBe(true);
    expect(f.fcm).toHaveBeenCalledTimes(1);
    expect(prepareNearbyRequestRinging).not.toHaveBeenCalled();
  });
  it('never interprets a policy storage failure as permission to ring or as a missed request', async () => {
    const f = fixture();
    jest
      .mocked(prepareNearbyRequestRinging)
      .mockRejectedValue(new Error('policy unavailable'));
    expect(await f.deliver('trip_request_nearby')).toBe(false);
    expect(f.fcm).not.toHaveBeenCalled();
    expect(f.notices.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: NotificationStatus.FAILED }),
    );
  });
  it('allows the existing transport when not muted', async () => {
    const f = fixture();
    jest.mocked(prepareNearbyRequestRinging).mockResolvedValue(true);
    expect(await f.deliver('trip_request_nearby')).toBe(true);
    expect(f.fcm).toHaveBeenCalledTimes(1);
  });
  it('does not overlap timer batches and releases the guard after a failed batch', async () => {
    const { service } = fixture();
    let fail!: (reason: Error) => void;
    jest.mocked(reconcileNearbyRequestCooldowns).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const first = service.reconcileNearbyRequestRinging();
    await service.reconcileNearbyRequestRinging();
    expect(reconcileNearbyRequestCooldowns).toHaveBeenCalledTimes(1);
    fail(new Error('unavailable'));
    await first;
    await service.reconcileNearbyRequestRinging();
    expect(reconcileNearbyRequestCooldowns).toHaveBeenCalledTimes(2);
  });
  it('migration is additive, indexed and uniquely identifies one driver/order; down removes only its new tables', async () => {
    const query = jest.fn(async (_sql: string) => undefined);
    const migration = new NearbyRequestRingingCooldown1780000087000();
    await migration.up({ query } as never);
    const sql = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(sql).toContain('PRIMARY KEY ("driverId", "requestId")');
    expect(sql).toContain('WHERE "processedAt" IS NULL');
    expect(sql).toContain('"mutedUntil" timestamptz');
    expect(sql).not.toMatch(/ALTER TABLE|UPDATE users|DELETE FROM/);
    query.mockClear();
    await migration.down({ query } as never);
    expect(query.mock.calls.flat()).toEqual([
      'DROP TABLE nearby_driver_ring_events',
      'DROP TABLE nearby_driver_ring_state',
    ]);
  });
});
