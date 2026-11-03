import { issueRideRingPermit, readRideRingPermit } from './ride-ring-permit';
import { NotificationService } from './notifications.service';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { androidDriverBackup } from './android-driver-backup';
import { nativeAndroidDriverPush } from './native-android-driver-push';
import { validateSync } from 'class-validator';
import { RideRingCheckDto } from './dto/ride-ring-check.dto';

const secret = 'test-only-secret-'.repeat(4);
const id = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';

describe('Delivery-time ride ringing permission', () => {
  afterEach(() => jest.useRealTimers());
  it('binds the capability to notification, recipient, purpose and original expiry', () => {
    const now = Date.now(), until = now + 40_000;
    const token = issueRideRingPermit(secret, id, user, until)!;
    expect(readRideRingPermit(secret, token, now)).toEqual({ notificationId: id, userId: user, until });
    expect(readRideRingPermit(secret, token, until)).toBeNull();
    expect(readRideRingPermit(secret, token.replace(id, user), now)).toBeNull();
    expect(readRideRingPermit(secret + 'other', token, now)).toBeNull();
    expect(readRideRingPermit(secret, `${token}x`, now)).toBeNull();
    expect(readRideRingPermit(secret, issueRideRingPermit(secret, id, user, now + 3600_000), now)).toBeNull();
    expect(issueRideRingPermit(undefined, id, user, until)).toBeUndefined();
  });

  function setup() {
    const now = Date.now();
    const row = { id, userId: user, isActive: true, createdAt: new Date(now),
      data: { type: 'driver_dispatch_offer', offerId: id, expiresAt: new Date(now + 40_000).toISOString() } };
    const service: any = Object.create(NotificationService.prototype);
    service.configService = { get: (key: string) => key === 'JWT_SECRET' ? secret : 'true' };
    service.notificationRepository = { findOne: jest.fn().mockResolvedValue(row), manager: { query: jest.fn().mockResolvedValue([{ passengerId: 'passenger' }]) } };
    service.userRepository = { findOne: jest.fn().mockResolvedValue({ id: user, role: UserRole.DRIVER, isActive: true, status: UserStatus.ACTIVE }) };
    return { service, row, token: issueRideRingPermit(secret, id, user, now + 40_000)! };
  }

  it('rejects malformed capabilities before touching the database', async () => {
    const { service } = setup();
    expect(await service.validateRideRing('invalid')).toEqual({ allowed: false });
    expect(service.notificationRepository.findOne).not.toHaveBeenCalled();
  });
  it('allows an active invitation, using recipient-scoped lookup and live business eligibility', async () => {
    const { service, token } = setup();
    expect(await service.validateRideRing(token)).toEqual({ allowed: true });
    expect(service.notificationRepository.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id, userId: user, isActive: true } }));
    expect(service.notificationRepository.manager.query).toHaveBeenCalledWith(expect.stringContaining("o.status = 'pending'"), [id, user]);
  });
  it.each(['cancelled', 'accepted_elsewhere', 'expired', 'replaced_offer'])(
    'denies a push still queued by FCM when its live invitation is %s', async () => {
      const { service, token } = setup();
      service.notificationRepository.manager.query.mockResolvedValue([]);
      expect(await service.validateRideRing(token)).toEqual({ allowed: false });
    });
  it('denies retired notifications and suspended recipients', async () => {
    const { service, token } = setup();
    service.userRepository.findOne.mockResolvedValue({ role: UserRole.DRIVER, isActive: true, status: UserStatus.SUSPENDED });
    expect(await service.validateRideRing(token)).toEqual({ allowed: false });
    service.notificationRepository.findOne.mockResolvedValue(null);
    expect(await service.validateRideRing(token)).toEqual({ allowed: false });
    expect(service.notificationRepository.manager.query).not.toHaveBeenCalled();
  });
  it('does not grant permission on DB failure or when the original window ends during lookup', async () => {
    jest.useFakeTimers();
    const { service, token } = setup();
    service.notificationRepository.manager.query.mockRejectedValueOnce(new Error('database offline'));
    await expect(service.validateRideRing(token)).rejects.toThrow('database offline');
    service.notificationRepository.manager.query.mockImplementation(async () => {
      jest.advanceTimersByTime(40_000); return [{ passengerId: 'passenger' }];
    });
    expect(await service.validateRideRing(token)).toEqual({ allowed: false });
  });
  it('preserves the capability in direct and Expo-compatible Android payloads without persisting it', () => {
    const { service, row } = setup();
    const withPermit = service.withRideRingPermit(row);
    expect(row.data).not.toHaveProperty('ringValidationToken');
    const payload = androidDriverBackup(row as any, withPermit.data);
    expect(readRideRingPermit(secret, payload.ringValidationToken)).not.toBeNull();
    expect(JSON.parse(payload.body).ringValidationToken).toBe(payload.ringValidationToken);
    const native = nativeAndroidDriverPush(withPermit, 'synthetic-token', withPermit.data.expiresAt);
    expect(native.data.ringValidationToken).toBe(payload.ringValidationToken);
    expect(Buffer.byteLength(JSON.stringify(native.data))).toBeLessThan(4000);
  });
  it('rejects oversized, empty and non-string capabilities at the HTTP boundary', () => {
    for (const token of [undefined, '', 123, {}, 'x'.repeat(257)]) {
      expect(validateSync(Object.assign(new RideRingCheckDto(), { token })).length).toBeGreaterThan(0);
    }
    expect(validateSync(Object.assign(new RideRingCheckDto(), { token: setup().token }))).toEqual([]);
  });

  it('REST recovery returns the original recipient-bound permit, without persisting or extending it', async () => {
    jest.useFakeTimers();
    const { service, row } = setup();
    service.logger = { debug: jest.fn() };
    const query = { orderBy: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(), getManyAndCount: jest.fn().mockResolvedValue([[row], 1]), getCount: jest.fn().mockResolvedValue(1) };
    service.buildInboxQuery = jest.fn().mockReturnValue(query);
    const before = JSON.stringify(row);
    const result = await service.findAllByUser(user, { limit: 20, scope: 'critical' });
    const permit = readRideRingPermit(secret, result.notifications[0].data.ringValidationToken);
    expect(permit).toEqual({ notificationId: id, userId: user, until: Date.parse(row.data.expiresAt) });
    expect(result.notifications[0].data.ringUntil).toBe(row.data.expiresAt);
    expect(service.buildInboxQuery).toHaveBeenCalledWith(user, 'critical');
    expect(JSON.stringify(row)).toBe(before);
    jest.advanceTimersByTime(40_000);
    const expired = await service.findAllByUser(user);
    expect(expired.notifications[0].data).not.toHaveProperty('ringValidationToken');
    expect(JSON.stringify(row)).toBe(before);
  });

  it('preserves an explicitly shorter transport deadline on rehydration', () => {
    const { service, row } = setup();
    const until = Date.now() + 5000;
    const short = { ...row, data: { ...row.data, ringUntil: new Date(until).toISOString() } };
    const result = service.withRideRingPermit(short);
    expect(readRideRingPermit(secret, result.data.ringValidationToken)?.until).toBe(until);
    expect(result.data.ringUntil).toBe(short.data.ringUntil);
  });
});
