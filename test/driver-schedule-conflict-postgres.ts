import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Trip, TripStatus } from '../src/trips/entities/trip.entity';
import { TripRequest, TripRequestStatus } from '../src/trip-requests/entities/trip-request.entity';
import { User } from '../src/users/entities/user.entity';
import { Vehicle } from '../src/vehicles/entities/vehicle.entity';
import { assertDriverRequestSchedule, findDriverRequestConflict } from '../src/trip-requests/dispatch/driver-schedule-policy';
import { DriverScheduleConflictException } from '../src/common/driver-schedule-conflict';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import type { ArgumentsHost } from '@nestjs/common';

export function driverScheduleConflictPostgresTests(get: () => {
  source: DataSource;
  driver: () => Promise<{ user: User; vehicle: Vehicle }>;
  request: (immediate?: boolean) => Promise<TripRequest>;
}) {
  const at = (hours: number) => new Date(Date.now() + hours * 3600000);
  const tripData = (driverId: string, status = TripStatus.PENDING) => ({ driverId, status,
    departureDate: at(1), departureLocation: 'Départ prévu', arrivalLocation: 'Arrivée prévue',
    totalSeats: 4, availableSeats: 4, pricePerSeat: 1000 });

  it('returns the real conflicting public trip through the HTTP error filter, without accepting the request', async () => {
    const { source, driver, request } = get();
    const d = await driver(), wanted = await request(false);
    const trip = await source.getRepository(Trip).save(tripData(d.user.id));
    let rejection: unknown;
    try { await source.transaction(tx => assertDriverRequestSchedule(tx, d.user.id, wanted.id)); }
    catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(DriverScheduleConflictException);
    const json = jest.fn(), status = jest.fn().mockReturnValue({ json });
    new ApiExceptionFilter().catch(rejection, { switchToHttp: () => ({
      getRequest: () => ({ user: { userId: d.user.id }, method: 'POST', headers: {}, url: '/test/accept' }),
      getResponse: () => ({ setHeader: jest.fn(), status }),
    }) } as unknown as ArgumentsHost);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DRIVER_SCHEDULE_CONFLICT',
      conflict: { kind: 'trip', id: trip.id, driverId: d.user.id, departure: trip.departureLocation,
        arrival: trip.arrivalLocation, departureDate: trip.departureDate.toISOString(), status: 'upcoming' } }));
    expect(await source.getRepository(TripRequest).findOneByOrFail({ id: wanted.id }))
      .toMatchObject({ status: TripRequestStatus.PENDING, selectedDriverId: null });
  });

  it('identifies an assigned request without a trip, then prefers its linked trip without duplication', async () => {
    const { source, driver, request } = get();
    const d = await driver(), wanted = await request(false), assigned = await request(false);
    await source.getRepository(TripRequest).update(assigned.id, {
      status: TripRequestStatus.DRIVER_SELECTED, selectedDriverId: d.user.id,
    });
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id))
      .toMatchObject({ kind: 'request', id: assigned.id, status: 'driver_selected' });
    const trip = await source.getRepository(Trip).save({ ...tripData(d.user.id), tripRequestId: assigned.id });
    await source.getRepository(TripRequest).update(assigned.id, { tripId: trip.id });
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id))
      .toMatchObject({ kind: 'trip', id: trip.id });
    await source.getRepository(Trip).update(trip.id, { status: TripStatus.COMPLETED });
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id)).toBeUndefined();
  });

  it('identifies another acceptance in preparation, but not a simple unanswered invitation', async () => {
    const { source, driver, request } = get();
    const d = await driver(), wanted = await request(false), preparing = await request(false);
    await source.query(`INSERT INTO trip_request_dispatch_offers
      (id, "requestId", "driverId", "vehicleId", seats, status, phase, "expiresAt")
      VALUES ($1,$2,$3,$4,1,'pending','accepting',now()+interval '1 minute')`, [randomUUID(), preparing.id, d.user.id, d.vehicle.id]);
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id))
      .toMatchObject({ kind: 'request', id: preparing.id, status: 'preparing' });
    await source.query(`UPDATE trip_request_dispatch_offers SET phase='driver' WHERE "requestId"=$1`, [preparing.id]);
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id)).toBeUndefined();
  });

  it('keeps compatible schedules and other drivers out of the explanation', async () => {
    const { source, driver, request } = get();
    const d = await driver(), other = await driver(), wanted = await request(false);
    const trip = await source.getRepository(Trip).save({ ...tripData(d.user.id), departureDate: at(6) });
    await source.getRepository(Trip).save(tripData(other.user.id));
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id)).toBeUndefined();
    await expect(source.transaction(tx => assertDriverRequestSchedule(tx, d.user.id, wanted.id))).resolves.toBeUndefined();
    await source.getRepository(Trip).update(trip.id, { departureDate: at(1) });
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id)).toMatchObject({ id: trip.id });
  });

  it('prioritizes an ongoing course over a scheduled one and excludes the request being accepted', async () => {
    const { source, driver, request } = get();
    const d = await driver(), wanted = await request(false);
    await source.getRepository(Trip).save(tripData(d.user.id));
    const ongoing = await source.getRepository(Trip).save({ ...tripData(d.user.id, TripStatus.ACTIVE), departureDate: at(2) });
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id)).toMatchObject({ id: ongoing.id, status: 'ongoing' });
    await source.getRepository(Trip).update({ driverId: d.user.id }, { status: TripStatus.CANCELLED });
    await source.getRepository(TripRequest).update(wanted.id, { status: TripRequestStatus.DRIVER_SELECTED, selectedDriverId: d.user.id });
    expect(await findDriverRequestConflict(source.manager, d.user.id, wanted.id)).toBeUndefined();
  });
}
