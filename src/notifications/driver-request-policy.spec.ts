import { NotificationService } from './notifications.service';
import { NotificationStatus } from './entities/notification.entity';
import { DRIVER_REQUEST_NOTIFICATION_TYPES } from './driver-request-policy';

const fixture = () => {
  const query = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]), getCount: jest.fn().mockResolvedValue(0) };
  const notifications = { create: jest.fn(v => v), save: jest.fn(async v => v), createQueryBuilder: jest.fn(() => query) };
  const users = { findOne: jest.fn(), count: jest.fn().mockResolvedValue(1) };
  const service = new NotificationService({ get: jest.fn() } as never, notifications as never, users as never, {} as never);
  const send = jest.spyOn(service as any, 'sendFirebaseNotification').mockResolvedValue('synthetic-message');
  const deliver = (type: string, userId: string | null = 'recipient') => (service as any).deliverSavedNotification({
    id: 'notice', userId, fcmToken: 'old-token', data: { type }, status: NotificationStatus.PENDING,
  });
  return { service, notifications, users, query, send, deliver };
};

describe('Driver-only order alerts', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(DRIVER_REQUEST_NOTIFICATION_TYPES)('suppresses %s for a passenger, including a legacy driver flag', async type => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({ role: 'passenger', isDriver: true, isActive: true, status: 'active', fcmToken: 'current-token' });
    expect(await f.deliver(type)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.notifications.save).toHaveBeenCalledWith(expect.objectContaining({
      status: NotificationStatus.FAILED, isActive: false, errorMessage: 'DRIVER_REQUEST_RECIPIENT_REQUIRED',
    }));
  });

  it.each([null, { role: 'driver', isActive: false, status: 'active' },
    { role: 'driver', isActive: true, status: 'suspended' }, { role: 'driver', isActive: true, status: 'inactive' }])(
    'does not deliver to a missing or disabled driver (%j)', async user => {
      const f = fixture(); f.users.findOne.mockResolvedValue(user);
      expect(await f.deliver('trip_request_nearby')).toBe(false); expect(f.send).not.toHaveBeenCalled();
    },
  );

  it('rechecks the current role on every delivery without an additional eligibility query', async () => {
    const f = fixture();
    f.users.findOne.mockResolvedValueOnce({ role: 'driver', isActive: true, status: 'active', fcmToken: 'current-token' })
      .mockResolvedValueOnce({ role: 'passenger', isActive: true, status: 'active', fcmToken: 'current-token' });
    expect(await f.deliver('driver_dispatch_offer')).toBe(true);
    expect(await f.deliver('driver_dispatch_offer')).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.users.findOne).toHaveBeenCalledTimes(2);
  });

  it.each(['trip_request_accepted', 'trip_request_reopened', 'trip_request_expired', 'trip_request_driver_overdue', 'trip_started', 'booking_confirmed'])(
    'preserves a passenger’s own lifecycle notification: %s', async type => {
      const f = fixture();
      f.users.findOne.mockResolvedValue({ role: 'passenger', isActive: true, status: 'active', fcmToken: 'current-token' });
      expect(await f.deliver(type)).toBe(true); expect(f.send).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects anonymous deliveries and token-only broadcast of other passengers’ orders', async () => {
    const f = fixture(); expect(await f.deliver('trip_request', null)).toBe(false);
    await f.service.sendToMultiple(['synthetic-token'], 'Order', 'Message', { type: 'trip_request' });
    expect(f.send).not.toHaveBeenCalled(); expect(f.notifications.create).not.toHaveBeenCalled();
  });

  it('applies the same eligibility filter before pagination, totals and unread counts', async () => {
    const f = fixture(); await f.service.findAllByUser('recipient', { limit: 10, offset: 20 });
    const conditions = f.query.andWhere.mock.calls.filter(([sql]) => String(sql).includes('driverRequestTypes'));
    expect(conditions).toHaveLength(2);
    expect(conditions[0][0]).toContain('EXISTS (SELECT 1 FROM users viewer WHERE viewer.id = :userId');
    expect(conditions[0][1]).toEqual({ driverRequestTypes: [...DRIVER_REQUEST_NOTIFICATION_TYPES],
      notificationDriverRole: 'driver', inactiveDriverStatuses: ['suspended', 'inactive'] });
    expect(f.query.take).toHaveBeenCalledWith(10); expect(f.query.skip).toHaveBeenCalledWith(20);
  });
});
