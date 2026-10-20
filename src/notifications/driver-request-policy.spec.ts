import { NotificationService } from './notifications.service';
import { NotificationStatus } from './entities/notification.entity';
import { DRIVER_REQUEST_NOTIFICATION_TYPES } from './driver-request-policy';

const fixture = () => {
  const query = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]), getCount: jest.fn().mockResolvedValue(0) };
  const ownerQuery = jest.fn().mockResolvedValue([{ passengerId: 'author' }]);
  const notifications = { create: jest.fn(v => v), save: jest.fn(async v => v), createQueryBuilder: jest.fn(() => query),
    manager: { query: ownerQuery } };
  const users = { findOne: jest.fn(), count: jest.fn().mockResolvedValue(1) };
  const service = new NotificationService({ get: jest.fn() } as never, notifications as never, users as never, {} as never);
  const send = jest.spyOn(service as any, 'sendFirebaseNotification').mockResolvedValue('synthetic-message');
  const deliver = (type: string, userId: string | null = 'recipient', data: Record<string, unknown> = {}) => (service as any).deliverSavedNotification({
    id: 'notice', userId, fcmToken: 'old-token', data: { type, passengerId: 'author', ...data }, status: NotificationStatus.PENDING,
  });
  return { service, notifications, users, query, ownerQuery, send, deliver };
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
    expect(f.ownerQuery).not.toHaveBeenCalled();
  });

  it.each(DRIVER_REQUEST_NOTIFICATION_TYPES)('suppresses an author-driver’s own %s before transport', async type => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({ role: 'driver', isActive: true, status: 'active', fcmToken: 'current-token' });
    expect(await f.deliver(type, 'recipient', { passengerId: 'recipient' })).toBe(false);
    expect(f.send).not.toHaveBeenCalled(); expect(f.ownerQuery).not.toHaveBeenCalled();
    expect(f.notifications.save).toHaveBeenCalledWith(expect.objectContaining({
      isActive: false, errorMessage: 'DRIVER_REQUEST_SELF_NOTIFICATION',
    }));
  });

  it.each(DRIVER_REQUEST_NOTIFICATION_TYPES)('checks ownership for an old %s without passengerId', async type => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({ role: 'driver', isActive: true, status: 'active', fcmToken: 'current-token' });
    f.ownerQuery.mockResolvedValueOnce([{ passengerId: 'recipient' }]);
    expect(await f.deliver(type, 'recipient', { passengerId: undefined, tripRequestId: 'order' })).toBe(false);
    expect(f.ownerQuery).toHaveBeenCalledWith(expect.stringContaining('r.id = $1'), ['order']);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('resolves old offer-only alerts and carries ownership to transport without losing the action', async () => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({ role: 'driver', isActive: true, status: 'active', fcmToken: 'current-token' });
    expect(await f.deliver('driver_dispatch_offer', 'recipient', { passengerId: undefined, offerId: 'offer' })).toBe(true);
    expect(f.ownerQuery).toHaveBeenCalledWith(expect.stringContaining('o.id = $1'), ['offer']);
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({
      data: { type: 'driver_dispatch_offer', offerId: 'offer', passengerId: 'author' },
    }), 'current-token');
  });

  it('keeps missing/deleted orders silent and transient ownership failures retryable', async () => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({ role: 'driver', isActive: true, status: 'active', fcmToken: 'current-token' });
    f.ownerQuery.mockResolvedValueOnce([]);
    expect(await f.deliver('trip_request_nearby', 'recipient', { passengerId: undefined, tripRequestId: 'deleted' })).toBe(false);
    expect(f.notifications.save).toHaveBeenLastCalledWith(expect.objectContaining({
      isActive: false, errorMessage: 'DRIVER_REQUEST_OWNER_UNAVAILABLE',
    }));
    f.ownerQuery.mockRejectedValueOnce(new Error('private database detail'));
    expect(await f.deliver('trip_request_nearby', 'recipient', { passengerId: undefined, tripRequestId: 'order' })).toBe(false);
    expect(f.notifications.save).toHaveBeenLastCalledWith(expect.objectContaining({
      status: NotificationStatus.FAILED, errorMessage: 'DRIVER_REQUEST_OWNER_CHECK_FAILED',
    }));
    expect(f.notifications.save.mock.calls.at(-1)![0].isActive).not.toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['trip_request_nearby', 'driver_dispatch_offer'])('rechecks the real author in the existing %s retry query', async type => {
    const f = fixture(); (f.service as any).configService.get = () => 'true';
    const notification = { userId: 'recipient', data: { type, tripRequestId: 'order', offerId: 'offer',
      driverId: 'recipient', ringAlert: 'nearby-request-v1', alertExpiresAt: new Date(Date.now() + 60000).toISOString() } };
    expect(await (f.service as any).isCriticalNotificationStillDeliverable(notification)).toBe(true);
    expect(f.ownerQuery).toHaveBeenCalledWith(expect.stringContaining('r."passengerId" <> $2'),
      [type === 'driver_dispatch_offer' ? 'offer' : 'order', 'recipient']);
    expect(notification.data).toMatchObject({ passengerId: 'author' });
    f.ownerQuery.mockResolvedValueOnce([]);
    expect(await (f.service as any).isCriticalNotificationStillDeliverable(notification)).toBe(false);
  });

  it.each(['trip_request_accepted', 'booking_response', 'driver_offer'])('preserves %s for a driver riding as passenger', async type => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({ role: 'driver', isActive: true, status: 'active', fcmToken: 'current-token' });
    expect(await f.deliver(type, 'recipient', { passengerId: 'recipient' })).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.ownerQuery).not.toHaveBeenCalled();
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
