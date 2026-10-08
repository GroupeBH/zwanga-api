import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { NotificationService } from '../notifications/notifications.service';
import { TripRequest, TripRequestStatus } from './entities/trip-request.entity';
import { DriverOffer, DriverOfferStatus } from './entities/driver-offer.entity';
import { DriverDispatchService } from './dispatch/dispatch.service';
import { TripRequestsService } from './trip-requests.service';

function fixture() {
  const driver = Object.assign(new User(), { id: 'driver', role: UserRole.DRIVER, status: UserStatus.ACTIVE, isActive: true });
  const passenger = Object.assign(new User(), { id: 'passenger', firstName: 'Passager', lastName: 'Test', phone: '+243999000111', email: 'private@example.invalid' });
  const request = Object.assign(new TripRequest(), { id: 'request', passengerId: passenger.id, passenger,
    status: TripRequestStatus.PENDING, departureDateMax: new Date(Date.now() + 60_000), driverOffers: [] });
  const requests = { findOne: jest.fn().mockResolvedValue(request), update: jest.fn() };
  const identity = { findOne: jest.fn().mockResolvedValue({ status: KycStatus.APPROVED }) };
  const vehicles = { exists: jest.fn().mockResolvedValue(true) };
  const users = { findOne: jest.fn().mockResolvedValue(driver), manager: { getRepository: jest.fn(entity => entity === KycDocument ? identity : vehicles) } };
  const dispatch = { getContactDeadline: jest.fn().mockResolvedValue(new Date(Date.now() + 20_000)) };
  const dependencies = [requests, {}, users, {}, {}, {}, {}, {}, {}, {}, {}, {}, dispatch] as unknown as ConstructorParameters<typeof TripRequestsService>;
  return { service: new TripRequestsService(...dependencies), driver, passenger, request, requests, identity, vehicles, users, dispatch };
}

describe('Explicit passenger contact before request acceptance', () => {
  it('returns only the authorized contact and deadline without accepting, expiring or starting a trip', async () => {
    const f = fixture();
    const result = await f.service.getPassengerContact('request', 'driver');
    expect(result).toEqual({ requestId: 'request', passenger: { id: 'passenger', name: 'Passager Test', phone: f.passenger.phone },
      expiresAt: new Date(f.request.departureDateMax.getTime() + 3 * 60 * 60_000).toISOString(), serverNow: expect.any(String) });
    expect(f.requests.findOne).toHaveBeenCalledTimes(1);
    expect(f.requests.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'request' }, select: expect.objectContaining({ passenger: { id: true, firstName: true, lastName: true, phone: true } }),
    }));
    expect(f.requests.update).not.toHaveBeenCalled();
    expect(f.dispatch.getContactDeadline).not.toHaveBeenCalled();
    expect(f.request.status).toBe(TripRequestStatus.PENDING);
  });

  it('also supports requests with offers and passengers without a phone', async () => {
    const f = fixture(); f.request.status = TripRequestStatus.OFFERS_RECEIVED; f.passenger.phone = '';
    expect((await f.service.getPassengerContact('request', 'driver')).passenger.phone).toBeNull();
  });

  it.each([UserRole.PASSENGER, UserRole.ADMIN, UserRole.SUPER_ADMIN])('denies current database role %s even with a stale driver JWT', async role => {
    const f = fixture(); f.driver.role = role;
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.requests.findOne).not.toHaveBeenCalled();
  });

  it.each([UserStatus.SUSPENDED, UserStatus.INACTIVE])('denies a %s account', async status => {
    const f = fixture(); f.driver.status = status;
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies missing, inactive and anonymous drivers', async () => {
    const f = fixture(); f.driver.isActive = false;
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(ForbiddenException);
    f.users.findOne.mockResolvedValueOnce(null);
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.getPassengerContact('request', '')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires the latest approved identity and an active vehicle, with the existing driver eligibility rules', async () => {
    const f = fixture(); f.identity.findOne.mockResolvedValueOnce({ status: KycStatus.REJECTED });
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(BadRequestException);
    f.vehicles.exists.mockResolvedValue(false);
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(BadRequestException);
    expect(f.requests.findOne).not.toHaveBeenCalled();
  });

  it.each([TripRequestStatus.CANCELLED, TripRequestStatus.EXPIRED, TripRequestStatus.DRIVER_SELECTED])('denies %s requests', async status => {
    const f = fixture(); f.request.status = status;
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects all assignment indicators, self contact, expired/malformed dates and missing requests', async () => {
    const cases: Partial<TripRequest>[] = [
      { passengerId: 'driver' }, { selectedDriverId: 'another' }, { tripId: 'trip' },
      { driverOffers: [Object.assign(new DriverOffer(), { status: DriverOfferStatus.ACCEPTED })] },
      { departureDateMax: new Date(Date.now() - 3 * 60 * 60_000 - 1) }, { departureDateMax: new Date(NaN) },
    ];
    for (const patch of cases) {
      const f = fixture(); Object.assign(f.request, patch);
      await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(NotFoundException);
    }
    const f = fixture(); f.requests.findOne.mockResolvedValue(null);
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('limits immediate requests to the active offer recipient and the offer deadline', async () => {
    const f = fixture(); f.request.immediateDispatch = true;
    const expiresAt = new Date(Date.now() + 10_000);
    f.dispatch.getContactDeadline.mockResolvedValue(expiresAt);
    const result = await f.service.getPassengerContact('request', 'driver');
    expect(result.expiresAt).toBe(expiresAt.toISOString());
    expect(f.dispatch.getContactDeadline).toHaveBeenCalledWith('driver', 'request');
    f.dispatch.getContactDeadline.mockResolvedValueOnce(null);
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(NotFoundException);
    f.dispatch.getContactDeadline.mockResolvedValueOnce(new Date(Date.now() - 1));
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not extend an offer or access an unallocated immediate request', async () => {
    const f = fixture(); f.request.immediateDispatch = true; f.dispatch.getContactDeadline.mockResolvedValue(null);
    await expect(f.service.getPassengerContact('request', 'driver')).rejects.toBeInstanceOf(NotFoundException);
    expect(f.requests.update).not.toHaveBeenCalled();
  });
});

describe('Immediate request contact authorization query', () => {
  it('uses the pending request index and bound identity, failing closed when disabled or unassigned', async () => {
    let enabled = false;
    const deadline = new Date(Date.now() + 10000);
    const db = { query: jest.fn().mockResolvedValue([{ expiresAt: deadline }]) };
    const service = new DriverDispatchService(db as unknown as DataSource,
      { get: () => enabled ? 'true' : 'false' } as unknown as ConfigService, {} as NotificationService);
    expect(await service.getContactDeadline('driver', 'request')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    enabled = true;
    expect(await service.getContactDeadline('driver', 'request')).toEqual(deadline);
    const [query, parameters] = db.query.mock.calls[0] as [string, string[]];
    expect(parameters).toEqual(['request', 'driver']);
    for (const clause of ['o."requestId" = $1', 'o."driverId" = $2', "o.status = 'pending'",
      'o."expiresAt" > now()', "r.status = 'pending'", 'r."selectedDriverId" IS NULL', 'r."tripId" IS NULL', 'LIMIT 1']) {
      expect(query).toContain(clause);
    }
    db.query.mockResolvedValueOnce([]);
    expect(await service.getContactDeadline('driver', 'request')).toBeNull();
  });
});
