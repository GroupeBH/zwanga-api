import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import { driverAlertLocationTimeSql } from '../src/trip-requests/dispatch/driver-alert-location-policy';
import { sequentialCandidates, lockNextQueuedCandidate } from '../src/trip-requests/dispatch/sequential-candidates';
import { latestDriverPositionSql, assertRequestDriverProximity } from '../src/trip-requests/request-proximity';
import { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { NotificationService } from '../src/notifications/notifications.service';
import { Notification } from '../src/notifications/entities/notification.entity';
import { User } from '../src/users/entities/user.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { Trip, TripStatus } from '../src/trips/entities/trip.entity';

type Fixture = { source: DataSource; service: DriverDispatchService;
  driver: () => Promise<{ user: User; vehicle: Vehicle }>;
  request: (immediate?: boolean) => Promise<TripRequest>; offers: (id: string) => Promise<unknown[]> };

/** Runs inside the existing disposable PostGIS fixture, never the application database. */
export function driverAlertLocationPostgresTests(fixture: () => Fixture) {
  it('48-hour SQL boundary is strict, null-safe and retains the five-second clock tolerance', async () => {
    const { source } = fixture();
    await source.transaction(async manager => {
      for (const [offset, expected] of [[-172799999, true], [-172800000, false], [-172800001, false],
        [-3600000, true], [5000, true], [5001, false]] as const) {
        const [row] = await manager.query(`SELECT ${driverAlertLocationTimeSql("now() + $1 * interval '1 millisecond'")} AS eligible`, [offset]);
        expect(row.eligible).toBe(expected);
      }
      const [row] = await manager.query(`SELECT COALESCE(${driverAlertLocationTimeSql('NULL::timestamptz')},false) AS eligible`);
      expect(row.eligible).toBe(false);
    });
  });

  it.each([true, false])('does not enqueue a request alert at 48 hours, then resumes after a fresh fix (%s)', async immediate => {
    const { source, service, driver, request, offers } = fixture();
    const d = await driver(), r = await request(immediate);
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '48 hours' WHERE "driverId"=$1`, [d.user.id]);
    expect(await service.notifyScheduledRequest(r.id, immediate)).toBe(false);
    expect(await offers(r.id)).toHaveLength(0);
    expect(await source.getRepository(Notification).count()).toBe(0);
    // Storage/read and manual browsing are not disabled by the ringing age limit.
    expect((await service.status(d.user.id)).available).toBe(true);
    await expect(assertRequestDriverProximity(source.manager, r.id, d.user.id)).resolves.toBeUndefined();
    await service.recordPosition(d.user.id, { latitude: -4.3, longitude: 15.31, accuracy: 20, recordedAt: new Date().toISOString() });
    expect(await service.notifyScheduledRequest(r.id, immediate)).toBe(true);
    expect(await source.getRepository(Notification).count()).toBe(1);
  });

  it('rechecks age for an already queued candidate without deleting the last known point', async () => {
    const { source, driver, request } = fixture();
    const d = await driver(), r = await request();
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '47 hours' WHERE "driverId"=$1`, [d.user.id]);
    expect((await sequentialCandidates(source.manager, r)).map(c => c.driverId)).toEqual([d.user.id]);
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '48 hours' WHERE "driverId"=$1`, [d.user.id]);
    await source.transaction(async manager => {
      expect(await lockNextQueuedCandidate(manager, r, [d.user.id])).toEqual({ driverId: d.user.id, candidate: null });
    });
    expect(await sequentialCandidates(source.manager, r)).toHaveLength(0);
    expect((await source.query('SELECT position FROM driver_dispatch_presence WHERE "driverId"=$1', [d.user.id]))[0].position).toBeTruthy();
  });

  it.each([true, false])('rechecks age before deferred push/socket delivery (%s)', async immediate => {
    const { source, service, driver, request } = fixture();
    const d = await driver(), r = await request(immediate);
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '47 hours' WHERE "driverId"=$1`, [d.user.id]);
    await service.notifyScheduledRequest(r.id, immediate);
    const notification = await source.getRepository(Notification).findOneByOrFail({ userId: d.user.id });
    const publish = jest.fn();
    const delivery = new NotificationService(new ConfigService({ DRIVER_DISPATCH_ENABLED: 'true' }),
      source.getRepository(Notification), source.getRepository(User), source.getRepository(TripRequest), { publish } as never);
    expect(await delivery['isCriticalNotificationStillDeliverable'](notification)).toBe(true);
    await source.query(`UPDATE driver_dispatch_presence SET "updatedAt"=now()-interval '48 hours' WHERE "driverId"=$1`, [d.user.id]);
    expect(await delivery['isCriticalNotificationStillDeliverable'](notification)).toBe(false);
    await delivery['publishRealtimeInvitation'](notification);
    expect(publish).not.toHaveBeenCalled();
  });

  it('uses ongoing navigation freshness without changing the ride or accepting an old navigation point', async () => {
    const { source, driver, request } = fixture();
    const d = await driver(), r = await request();
    await source.query('DELETE FROM driver_dispatch_presence WHERE "driverId"=$1', [d.user.id]);
    const trip = await source.getRepository(Trip).save({ driverId: d.user.id, vehicleId: d.vehicle.id,
      status: TripStatus.ACTIVE, departureLocation: 'Fixture', arrivalLocation: 'Fixture', departureDate: new Date(),
      totalSeats: 4, availableSeats: 2, pricePerSeat: 500, currentLocation: r.departurePoint,
      lastLocationUpdateAt: new Date(Date.now() - 47 * 3600000) });
    expect((await sequentialCandidates(source.manager, r)).map(c => c.driverId)).toEqual([d.user.id]);
    await source.getRepository(Trip).update(trip.id, { lastLocationUpdateAt: new Date(Date.now() - 48 * 3600000) });
    expect(await sequentialCandidates(source.manager, r)).toHaveLength(0);
    const [row] = await source.query(`SELECT ${latestDriverPositionSql('$1', true)} AS alert,
      ${latestDriverPositionSql('$1')} AS browsing`, [d.user.id]);
    expect(row.alert).toBeNull(); expect(row.browsing).toBeTruthy();
    expect((await source.getRepository(Trip).findOneByOrFail({ id: trip.id })).status).toBe(TripStatus.ACTIVE);
  });
}
