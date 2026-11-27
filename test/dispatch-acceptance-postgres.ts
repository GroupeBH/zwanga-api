import type { DataSource } from 'typeorm';
import { DriverDispatchService } from '../src/trip-requests/dispatch/dispatch.service';
import { TripRequest } from '../src/trip-requests/entities/trip-request.entity';
import { DriverOffer } from '../src/trip-requests/entities/driver-offer.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';
import { KycDocument, KycStatus } from '../src/users/entities/kyc-document.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { Trip, TripStatus } from '../src/trips/entities/trip.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import * as outbox from '../src/notifications/transactional-notification';

/** Runs exclusively in the dispatch suite's disposable PostGIS cluster. */
export function dispatchAcceptancePostgresTests(get: () => {
  source: DataSource; service: DriverDispatchService;
  driver: () => Promise<{ user: User; vehicle: Vehicle }>;
  request: () => Promise<TripRequest>;
  offers: (id: string) => Promise<any[]>;
}) {
  async function fixture() {
    const f = get(), d = await f.driver(), r = await f.request();
    await f.service['allocate'](r.id);
    return { ...f, d, r, offer: (await f.offers(r.id))[0] };
  }

  it('accepts in 12 SQL round trips including BEGIN/COMMIT, with one fresh admission projection', async () => {
    const f = await fixture();
    const sql: string[] = [];
    const log = jest.spyOn(f.source.logger, 'logQuery').mockImplementation(query => { sql.push(query); });
    try {
      await expect(f.service.respond(f.d.user.id, f.offer.id, 'accept')).resolves.toMatchObject({ status: 'accepted' });
    } finally { log.mockRestore(); }
    expect(sql).toHaveLength(12);
    expect(sql.filter(q => q.includes('AS "identityApproved"'))).toHaveLength(1);
    expect(sql.filter(q => q.includes('busy_trip'))).toHaveLength(1);
    expect(sql.findIndex(q => q.includes('FOR NO KEY UPDATE')))
      .toBeLessThan(sql.findIndex(q => q.includes('AS "identityApproved"')));
    expect(await f.source.getRepository(DriverOffer).countBy({ tripRequestId: f.r.id })).toBe(1);
    const n = await f.source.getRepository(Notification).findOneByOrFail({ eventKey: `dispatch-accepted:${f.offer.id}` });
    expect(n).toMatchObject({ userId: f.r.passengerId, status: 'pending', data: { driverId: f.d.user.id } });
    const stored = await f.source.getRepository(DriverOffer).findOneByOrFail({ tripRequestId: f.r.id });
    expect(stored.departurePoint).toEqual(f.r.departurePoint);
    expect(stored.arrivalPoint).toEqual(f.r.arrivalPoint);
  });

  it.each(['inactive', 'suspended', 'passenger', 'kyc', 'vehicle', 'opt-out', 'far', 'phase'])(
    'rechecks %s after the invitation was sent, without committing a selection', async restriction => {
      const f = await fixture();
      if (restriction === 'inactive') await f.source.getRepository(User).update(f.d.user.id, { isActive: false });
      if (restriction === 'suspended') await f.source.getRepository(User).update(f.d.user.id, { status: UserStatus.SUSPENDED });
      if (restriction === 'passenger') await f.source.getRepository(User).update(f.d.user.id, { role: UserRole.PASSENGER });
      if (restriction === 'kyc') await f.source.getRepository(KycDocument).save({ userId: f.d.user.id, status: KycStatus.REJECTED });
      if (restriction === 'vehicle') await f.source.getRepository(Vehicle).update(f.d.vehicle.id, { isActive: false });
      if (restriction === 'opt-out') await f.source.query('UPDATE driver_dispatch_presence SET "discoveryEnabled"=false WHERE "driverId"=$1', [f.d.user.id]);
      if (restriction === 'far') await f.source.query('UPDATE driver_dispatch_presence SET position=ST_SetSRID(ST_MakePoint(16.3,-4.3),4326)::geography WHERE "driverId"=$1', [f.d.user.id]);
      if (restriction === 'phase') {
        await f.source.getRepository(TripRequest).update(f.r.id, { sequentialDispatch: true });
        await f.source.query("UPDATE trip_request_dispatch_offers SET phase='passenger' WHERE id=$1", [f.offer.id]);
      }
      await expect(f.service.respond(f.d.user.id, f.offer.id, 'accept')).rejects.toThrow();
      expect((await f.source.getRepository(TripRequest).findOneByOrFail({ id: f.r.id })).selectedDriverId).toBeNull();
      expect(await f.source.getRepository(DriverOffer).countBy({ tripRequestId: f.r.id })).toBe(0);
      expect(await f.source.getRepository(Notification).countBy({ eventKey: `dispatch-accepted:${f.offer.id}` })).toBe(0);
    });

  it.each([0, 1, 6])('preserves ongoing and future trip conflicts (departure in %s hours)', async hours => {
    const f = await fixture();
    await f.source.getRepository(Trip).save({ driverId: f.d.user.id, vehicleId: f.d.vehicle.id,
      status: hours === 0 ? TripStatus.ACTIVE : TripStatus.PENDING,
      departureDate: new Date(Date.now() + hours * 3600000), departureLocation: 'Fixture', arrivalLocation: 'Fixture',
      totalSeats: 4, availableSeats: 4, pricePerSeat: 2500 });
    const result = f.service.respond(f.d.user.id, f.offer.id, 'accept');
    if (hours === 6) await expect(result).resolves.toMatchObject({ status: 'accepted' });
    else await expect(result).rejects.toMatchObject({ response: { code: 'DRIVER_SCHEDULE_CONFLICT' } });
  });

  it('rolls back selection, offer status, presence and driver offer if outbox insertion fails', async () => {
    const f = await fixture();
    const [before] = await f.source.query('SELECT "expiresAt" FROM driver_dispatch_presence WHERE "driverId"=$1', [f.d.user.id]);
    const fail = jest.spyOn(outbox, 'enqueueTransactionalNotification').mockRejectedValueOnce(new Error('synthetic outbox failure'));
    try { await expect(f.service.respond(f.d.user.id, f.offer.id, 'accept')).rejects.toThrow('synthetic outbox failure'); }
    finally { fail.mockRestore(); }
    expect((await f.source.getRepository(TripRequest).findOneByOrFail({ id: f.r.id })).selectedDriverId).toBeNull();
    expect((await f.offers(f.r.id))[0].status).toBe('pending');
    expect(await f.source.getRepository(DriverOffer).countBy({ tripRequestId: f.r.id })).toBe(0);
    expect((await f.source.query('SELECT "expiresAt" FROM driver_dispatch_presence WHERE "driverId"=$1', [f.d.user.id]))[0]).toEqual(before);
    await expect(f.service.respond(f.d.user.id, f.offer.id, 'accept')).resolves.toMatchObject({ status: 'accepted' });
  });

  it('commits refusal, invitation closure and alert retirement in one statement', async () => {
    const f = await fixture(), sql: string[] = [];
    const log = jest.spyOn(f.source.logger, 'logQuery').mockImplementation(query => { sql.push(query); });
    try { await expect(f.service.respond(f.d.user.id, f.offer.id, 'decline')).resolves.toMatchObject({ status: 'declined' }); }
    finally { log.mockRestore(); }
    const writes = sql.filter(q => q.startsWith('WITH declined AS'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('INSERT INTO trip_request_driver_refusals');
    expect(writes[0]).toContain('UPDATE notifications');
    expect((await f.offers(f.r.id))[0].status).toBe('declined');
    expect(await f.source.query('SELECT 1 FROM trip_request_driver_refusals WHERE "requestId"=$1', [f.r.id])).toHaveLength(1);
    expect((await f.source.getRepository(Notification).findOneByOrFail({ eventKey: `dispatch-offer:${f.offer.id}` })).isActive).toBe(false);
  });

  it('rolls back refusal if alert retirement fails, and safely retries afterwards', async () => {
    const f = await fixture();
    await f.source.query(`CREATE FUNCTION fail_dispatch_refusal_test() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'synthetic refusal failure'; END; $body$`);
    await f.source.query('CREATE TRIGGER fail_dispatch_refusal_test BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION fail_dispatch_refusal_test()');
    try {
      await expect(f.service.respond(f.d.user.id, f.offer.id, 'decline')).rejects.toThrow('synthetic refusal failure');
      expect((await f.offers(f.r.id))[0].status).toBe('pending');
      expect(await f.source.query('SELECT 1 FROM trip_request_driver_refusals WHERE "requestId"=$1', [f.r.id])).toHaveLength(0);
      expect((await f.source.getRepository(Notification).findOneByOrFail({ eventKey: `dispatch-offer:${f.offer.id}` })).isActive).toBe(true);
    } finally {
      await f.source.query('DROP TRIGGER fail_dispatch_refusal_test ON notifications');
      await f.source.query('DROP FUNCTION fail_dispatch_refusal_test()');
    }
    await expect(f.service.respond(f.d.user.id, f.offer.id, 'decline')).resolves.toMatchObject({ status: 'declined' });
    await expect(f.service.respond(f.d.user.id, f.offer.id, 'decline')).resolves.toMatchObject({ status: 'declined' });
  });

  it.each(['account', 'schedule', 'deadline'])('sees %s changes committed while waiting for the owner lock', async change => {
    const f = await fixture(), blocker = f.source.createQueryRunner();
    let responding: Promise<unknown> | undefined;
    await blocker.connect(); await blocker.startTransaction();
    try {
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [f.d.user.id]);
      if (change === 'account') await blocker.manager.getRepository(User).update(f.d.user.id, { isActive: false });
      if (change === 'schedule') await blocker.manager.getRepository(Trip).save({ driverId: f.d.user.id,
        status: TripStatus.PENDING, departureDate: new Date(), departureLocation: 'Fixture', arrivalLocation: 'Fixture',
        totalSeats: 4, availableSeats: 4, pricePerSeat: 2500 });
      const expiry = Date.now() + 1200;
      if (change === 'deadline') await f.source.query('UPDATE trip_request_dispatch_offers SET "expiresAt"=$2 WHERE id=$1', [f.offer.id, new Date(expiry)]);
      responding = f.service.respond(f.d.user.id, f.offer.id, 'accept').then(value => ({ value }), error => ({ error }));
      let blocked = false;
      const until = Date.now() + 1500;
      while (!blocked && Date.now() < until) {
        const rows = await f.source.query("SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE%' AND wait_event_type='Lock'");
        blocked = rows.length > 0;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      if (change === 'deadline') await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry - Date.now() + 30)));
      await blocker.commitTransaction();
      const result = await responding as { error: { status: number; message: string } };
      expect(result.error.status).toBe(change === 'account' ? 403 : 409);
      if (change === 'deadline') expect(result.error.message).toContain('expiré');
      expect((await f.source.getRepository(TripRequest).findOneByOrFail({ id: f.r.id })).selectedDriverId).toBeNull();
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await responding;
      await blocker.release();
    }
  });
}
